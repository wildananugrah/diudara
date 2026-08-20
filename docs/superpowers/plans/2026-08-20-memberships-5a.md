# Memberships 5a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user defines a membership tier on their own profile, connects a payout account, and another signed-in user pays for it — leaving a subscription Phase 6 can gate on.

**Architecture:** New user-scoped tables (`user_tier`, `user_subscription`, `user_transaction`) beside the community-scoped ones, which are never touched. The Xendit adapter, its split rule and the claim-first payout sentinel are **reused**; the community-scoped use cases are not. The single Xendit webhook stream is routed by an `external_id` namespace.

**Tech Stack:** Bun 1.3.14, Hono, drizzle-orm + drizzle-kit, React 19, `bun test`, Xendit (existing adapter).

**Spec:** `docs/superpowers/specs/2026-08-20-memberships-5a-design.md` — read it before Task 1. This plan argues from it and does not restate its reasoning.

## Global Constraints

- **`/dashboard/*` and every table it reads are UNTOUCHABLE.** `community`, `membership_tier`, `member`, `subscription`, `transaction`, `creator` — no schema change, no query change, no behaviour change. Phase 8 deletes them; until then they keep running. If a task seems to require touching them, stop and report.
- **All user-facing copy is Bahasa Indonesia.** `NotFoundError` messages are English at every call site in this codebase — that rule is absolute; `ValidationError`/`ConflictError` carry Bahasa.
- **`src/test/no-raw-server-errors.test.ts` must stay green.** No web file renders `err.message`.
- **`apps/web/src/test/no-hanging-dom-assertions.test.ts` must stay green**, and **never put a DOM node on either side of an assertion that can fail** — it serialises the element's whole object graph and has taken this machine down once. Use the `isNode` pattern in `BerandaPage.test.tsx`.
- **Money rules, all three:** verify the amount against our own record, never the claimed one; be idempotent under redelivery; only `PAID` activates.
- **Tests assert literal values**, never the constant they check.
- **TDD.** Write the test, watch it fail *for its own reason*. A test file that fails to LOAD is not a red phase — stub the export first.
- **The Bash tool auto-backgrounds anything past 120 seconds and a backgrounded run never wakes you.** The api suite takes ~240 s: pass `timeout: 400000`. Run it once before committing, not per iteration.
- **Commit before mutation-testing.**
- **Never run a dev server, bind a port, or drive a browser.** The owner runs the gate (Task 11).

---

## Task 1: `user_tier` and its repository

**Files:**
- Modify: `apps/api/src/db/schema.ts` (append after `postMedia`)
- Modify: `apps/api/src/db/test-helpers.ts`
- Create: `apps/api/src/application/ports/user-tier-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-user-tier.repository.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-user-tier.repository.test.ts`

**Interfaces:**
- Consumes: `appUsers` from `../../db/schema`.
- Produces: `userTiers` (schema), `UserTierRow`, `UserTierRepositoryPort`, `DrizzleUserTierRepository`.

- [ ] **Step 1: Add the table**

```ts
export const userTiers = pgTable(
  "user_tier",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => appUsers.id),
    name: varchar("name", { length: 128 }).notNull(),
    // Integer rupiah, matching `membership_tier.price_amount`'s convention.
    priceAmount: integer("price_amount").notNull(),
    // varchar, not an enum, so 5b can add cycles without a migration — the same
    // reasoning `subscription.status` records for `past_due`/`churned`.
    billingCycle: varchar("billing_cycle", { length: 16 }).notNull(),
    // A deactivated tier stops being offered. Existing subscriptions to it are
    // unaffected — see the spec's §4.
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("user_tier_owner_idx").on(table.ownerId),
    // Redundant on its own — `id` is already unique. It exists ONLY so
    // `user_subscription` can carry a composite foreign key against
    // (id, owner_id), which is what makes its denormalised `owner_id`
    // impossible to falsify. Do not remove it as "duplicate".
    uniqueIndex("user_tier_id_owner_unique").on(table.id, table.ownerId),
  ]
);
```

- [ ] **Step 2: Generate the migration and READ the SQL**

Run: `cd apps/api && bun run db:generate`

Open the generated file. Confirm `user_tier_id_owner_unique` exists — the next task's foreign key cannot be created without it. This project has lost a day to drizzle emitting a modifier nobody asked for; read the SQL, do not assume it.

- [ ] **Step 3: Add `userTiers` to the test reset**

In `apps/api/src/db/test-helpers.ts`, before `appUsers`.

- [ ] **Step 4: Write the failing repository test**

Follow the harness style of `drizzle-media.repository.test.ts`. Cover: create returns the row; `listByOwner` returns only that owner's tiers, active first; `listActiveByOwner` excludes deactivated ones; `findById` returns null for an unknown id; `deactivate` flips `is_active` without deleting.

- [ ] **Step 5: Run it, watch it fail for its own reason**

A missing module is a load failure, not a red phase. Create the repository with every method throwing `new Error("not implemented")`, re-run, and confirm each test fails on its own assertion.

- [ ] **Step 6: Write the port and the implementation**

`DrizzleUserTierRepository`'s constructor takes a `DatabaseExecutor` — `new DrizzleUserTierRepository(db)` — like every repository in this codebase.

- [ ] **Step 7: Run the covering file, then the api suite once (`timeout: 400000`), then commit**

---

## Task 2: `user_subscription`, `user_transaction`, and their repository

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/db/test-helpers.ts`
- Create: `apps/api/src/application/ports/user-subscription-repository.port.ts`
- Create: `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.ts`
- Test: `apps/api/src/infrastructure/repositories/drizzle-user-subscription.repository.test.ts`

**Interfaces:**
- Consumes: `userTiers` (Task 1), `appUsers`.
- Produces: `userSubscriptions`, `userTransactions`, `UserSubscriptionRow`, `UserTransactionRow`, `UserSubscriptionRepositoryPort`, `DrizzleUserSubscriptionRepository`.

- [ ] **Step 1: Add both tables**

```ts
export const userSubscriptions = pgTable(
  "user_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => appUsers.id),
    tierId: uuid("tier_id").notNull(),
    /**
     * DENORMALISED from the tier, and kept honest by the composite foreign key
     * below rather than by anyone remembering. Phase 6 asks "is this viewer a
     * member of that person" on every gated post, and that must be one index
     * hit, not a join through the tier.
     */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => appUsers.id),
    /** `pending` | `active` | `cancelled`. 5b adds `past_due` and `churned`. */
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The whole point of `user_tier_id_owner_unique`: a subscription whose
    // owner disagrees with its tier's owner CANNOT BE INSERTED. No trigger, no
    // application invariant anyone can forget.
    foreignKey({
      columns: [table.tierId, table.ownerId],
      foreignColumns: [userTiers.id, userTiers.ownerId],
      name: "user_subscription_tier_owner_fk",
    }),
    // You cannot subscribe to yourself, exactly as `follow_no_self` forbids
    // following yourself.
    check("user_subscription_no_self", sql`${table.subscriberId} <> ${table.ownerId}`),
    // Nobody holds two live memberships to the same person — which is the
    // shape of accidentally paying twice.
    uniqueIndex("user_subscription_one_active")
      .on(table.subscriberId, table.ownerId)
      .where(sql`${table.status} = 'active'`),
    index("user_subscription_owner_idx").on(table.ownerId),
  ]
);

export const userTransactions = pgTable("user_transaction", {
  id: uuid("id").primaryKey().defaultRandom(),
  userSubscriptionId: uuid("user_subscription_id")
    .notNull()
    .references(() => userSubscriptions.id),
  // What WE believe is owed. The webhook compares the provider's claim against
  // this and never the other way round — see `handle-payment-webhook.ts`'s own
  // docstring for why that direction is the security property.
  amount: integer("amount").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  gatewayReferenceId: varchar("gateway_reference_id", { length: 255 }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

`foreignKey`, `check` and `uniqueIndex` may need adding to the drizzle import at the top of `schema.ts`.

- [ ] **Step 2: Generate the migration and READ the SQL**

Confirm three things by eye, because each is silently droppable: the composite FK names both columns, the CHECK is present, and the unique index carries `WHERE status = 'active'` (a non-partial unique index here would forbid a second subscription even after the first was cancelled — a bug that only appears months later).

- [ ] **Step 3: Add both tables to the test reset**, `userTransactions` before `userSubscriptions` before `userTiers`.

- [ ] **Step 4: Write the failing tests — the constraints are the point**

Beyond ordinary CRUD, three tests exist to prove the database refuses things:

```ts
it("REFUSES a subscription whose owner disagrees with its tier's owner", async () => {
  const alice = await createUser("alice");
  const bob = await createUser("bob");
  const carol = await createUser("carol");
  const tier = await tiers.create({ ownerId: alice.id, name: "Anggota", priceAmount: 50_000, billingCycle: "monthly" });

  // carol subscribing to a tier that is alice's, but claiming bob owns it.
  await expect(
    subs.create({ subscriberId: carol.id, tierId: tier.id, ownerId: bob.id })
  ).rejects.toThrow();
});

it("REFUSES subscribing to yourself", async () => {
  const alice = await createUser("alice");
  const tier = await tiers.create({ ownerId: alice.id, name: "Anggota", priceAmount: 50_000, billingCycle: "monthly" });

  await expect(
    subs.create({ subscriberId: alice.id, tierId: tier.id, ownerId: alice.id })
  ).rejects.toThrow();
});

it("REFUSES a second ACTIVE membership to the same person, but allows one after a cancellation", async () => {
  // ... create + activate one, assert the second insert rejects,
  // then cancel the first and assert a new one is accepted.
  // The second half is what proves the index is PARTIAL.
});
```

- [ ] **Step 5: Run, watch fail for their own reasons, implement**

The port needs at minimum: `create`, `findById`, `activate(id, periodEnd)`, `findActiveFor(subscriberId, ownerId)`, `createTransaction`, `findTransactionById`, `markTransactionPaid`.

- [ ] **Step 6: Run the covering file, the api suite once, then commit**

---

## Task 3: Payout onboarding on `app_user`

**Files:**
- Modify: `apps/api/src/db/schema.ts` (add `xenditAccountId` to `appUsers`)
- Create: `apps/api/src/application/use-cases/connect-user-payout.ts`
- Modify: `apps/api/src/routes/users.ts`
- Modify: `apps/api/src/bootstrap.ts`
- Test: `apps/api/src/application/use-cases/connect-user-payout.test.ts`, `apps/api/src/routes/users.test.ts`

**Interfaces:**
- Consumes: the existing `PaymentProviderPort`, and `XENDIT_ACCOUNT_PROVISIONING` / `isProvisioningPlaceholder` / the "connected" predicate from `apps/api/src/domain/payment-account.ts`. **Reuse that module. Do not write a second sentinel.**
- Produces: `ConnectUserPayout`, `GET|POST /users/me/payout`.

**Read first:** `apps/api/src/domain/payment-account.ts` and `apps/api/src/application/use-cases/create-payment-account.ts` in full. They encode a measured incident and you are reproducing their discipline for a different owner table.

- [ ] **Step 1: Add the column**

`xenditAccountId: varchar("xendit_account_id", { length: 255 })` on `appUsers`, nullable, with a comment pointing at `domain/payment-account.ts` for the three states.

- [ ] **Step 2: Write the failing tests, including the one that matters**

The ordinary ones: connecting sets the id; connecting twice is idempotent and does not call the provider again; a reader must use the "connected" predicate rather than a truthiness check, **because the sentinel is truthy**.

The one that matters:

```ts
it("N concurrent connects produce exactly ONE provider call", async () => {
  const user = await createUser("alice");
  let providerCalls = 0;
  const provider = { createSubAccount: async () => { providerCalls++; return `acct_${providerCalls}`; } };

  await Promise.all(Array.from({ length: 30 }, () => new ConnectUserPayout(users, provider).execute(user.id)));

  // 30 concurrent requests once produced 30 sub-accounts and orphaned 29.
  // A Xendit MANAGED sub-account is a KYC entity with no delete endpoint, so
  // every orphan is permanent. A SEQUENTIAL version of this test proves nothing.
  expect(providerCalls).toBe(1);
});
```

- [ ] **Step 3: Run, watch fail, implement with the claim-first UPDATE**

The conditional UPDATE claims the row with the sentinel **before** the provider is called, so losing callers never reach the provider at all.

- [ ] **Step 4: Add the routes**, authenticated, returning the connection status. `payout` is a new literal segment under `/users` — **it must join `RESERVED_HANDLES`**, and the route-derived guard in `routes/users.test.ts` will fail until it does. Run that guard before and after mounting, and verify with a positive control (remove the handle while the route is mounted, watch it fail, restore).

- [ ] **Step 5: Run the api suite once, then commit**

---

## Task 4: Managing tiers

**Files:**
- Create: `apps/api/src/application/use-cases/manage-user-tiers.ts`
- Modify: `apps/api/src/routes/users.ts`
- Test: alongside both.

**Interfaces:**
- Consumes: `UserTierRepositoryPort` (Task 1), the payout predicate (Task 3).
- Produces: `ManageUserTiers`, and `GET|POST|PATCH /users/me/tiers`.

- [ ] **Step 1: Write the failing tests**

Cover: creating a tier requires a **connected** payout account (a tier whose money has nowhere to go is a trap — spec §5) and the refusal is Bahasa naming the remedy; the sentinel does **not** count as connected; price must be positive; deactivating stops the tier being offered without touching existing subscriptions; one owner cannot edit another's tier.

- [ ] **Step 2: Run, watch fail, implement**

- [ ] **Step 3: Confirm the reserved-handle guard stays green — do NOT reserve `tiers`**

An earlier draft of this plan told you to add `tiers` to `RESERVED_HANDLES`. **That was wrong.** The
route-derived guard (`apps/api/src/routes/users.test.ts:190`) reads only the FIRST segment after
`/users/`, and your routes are `/users/me/tiers` — first segment `me`, already unregisterable at 2
characters. Nothing collides.

Reserving it would take an ordinary word from users to prevent a collision that cannot occur, and
`handle.test.ts` already asserts that segments the pattern makes impossible are deliberately absent
from the list. Run the guard before and after mounting and confirm it stays green:

```
cd apps/api && bun test src/routes/users.test.ts -t "every literal /users segment"
```

- [ ] **Step 4: Run the api suite once, then commit**

---

## Task 5: The offer on a profile

**Files:**
- Modify: `apps/api/src/application/use-cases/get-user-profile.ts`
- Modify: `apps/api/src/application/post-views.ts` or a new `tier-views.ts`
- Test: `apps/api/src/routes/users.test.ts`

**Interfaces:**
- Produces: `membership: { tiers: [{ id, name, priceAmount, billingCycle }] }` on the public profile.

- [ ] **Step 1: Write the failing tests**

The projection is closed: a tier on the wire is exactly `id, name, priceAmount, billingCycle` — never `ownerId`, never `isActive`, never `createdAt`. Only **active** tiers appear. A profile with no payout account or no tiers reports an empty list rather than omitting the field, so the web never branches on undefined.

- [ ] **Step 2: Run, watch fail, implement.** One query for the profile's tiers, not one per tier.

- [ ] **Step 3: Run the api suite once, then commit**

---

## Task 6: Starting a subscription

**Files:**
- Create: `apps/api/src/application/use-cases/start-user-subscription.ts`
- Create: `apps/api/src/domain/user-payment.ts`
- Modify: `apps/api/src/routes/users.ts`
- Test: alongside both.

**Interfaces:**
- Consumes: Tasks 1-3, the existing `PaymentProviderPort`.
- Produces: `StartUserSubscription`, `USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX`, `POST /users/:handle/subscribe`.

- [ ] **Step 1: Write the namespace, and its reason, in `domain/user-payment.ts`**

```ts
/**
 * Prefixes the `external_id` of every user-subscription invoice.
 *
 * Xendit delivers ONE webhook stream, and the community-scoped handler already
 * resolves its own invoices by treating `external_id` as a bare `transaction.id`
 * uuid. A user-subscription invoice must be distinguishable WITHOUT GUESSING —
 * so it is namespaced here, the webhook routes on the prefix, and anything
 * matching neither shape is IGNORED rather than assumed to be either.
 */
export const USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX = "usub_";

export function userSubscriptionExternalId(transactionId: string): string {
  return `${USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX}${transactionId}`;
}

/** `null` when this external id belongs to something else — never a guess. */
export function userTransactionIdFromExternalId(externalId: string): string | null {
  return externalId.startsWith(USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX)
    ? externalId.slice(USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX.length)
    : null;
}
```

- [ ] **Step 2: Write the failing tests for the refusals**

Each in Bahasa, each naming the remedy: signed out is a 401; subscribing to yourself is refused (the DB check is the backstop, not the message); an inactive tier is refused; an owner with no connected payout account is refused; **already holding an active membership to this owner is refused** rather than creating a second pending row.

- [ ] **Step 3: Write the failing test for the happy path**

A `pending` subscription and a `pending` transaction are created, the invoice is opened against **the owner's** sub-account, and the returned `external_id` carries the prefix.

- [ ] **Step 4: Run, watch fail, implement**

Row before provider call, so a failed provider call leaves a `pending` row rather than an invoice pointing at nothing.

- [ ] **Step 5: Run the api suite once, then commit**

---

## Task 7: The webhook

**Files:**
- Modify: `apps/api/src/application/use-cases/handle-payment-webhook.ts`
- Test: `apps/api/src/application/use-cases/handle-payment-webhook.test.ts`

**Read first:** the existing file in full, especially its docstring about comparing against `transaction.amount` rather than the payload's.

- [ ] **Step 1: Write the failing tests — all four money properties**

```ts
it("activates a user subscription when its invoice is PAID", async () => { /* ... */ });

it("IGNORES an external_id matching neither namespace, without throwing", async () => { /* ... */ });

it("is idempotent: the same PAID webhook twice activates once and extends the period once", async () => {
  // Redelivery is normal provider behaviour, not an edge case.
});

it("refuses a payload claiming a different amount than our own record", async () => {
  // The existing handler logs `[security] webhook amount mismatch` because this
  // was a real finding. Our record is the truth; the payload is a claim.
});

it("records but does not activate any status other than PAID", async () => { /* ... */ });

it("still resolves COMMUNITY invoices exactly as before", async () => {
  // The regression that matters: this task edits a handler serving live money.
});
```

- [ ] **Step 2: Run, watch fail, implement the routing**

Route on the prefix. Community behaviour must be reached by exactly the path it is today.

- [ ] **Step 3: Mutation-check before committing**

Break the amount comparison and confirm a named test reddens. Break idempotency and confirm another does. Restore both.

- [ ] **Step 4: Run the api suite once, then commit**

---

## Task 8: The membership check Phase 6 needs

**Files:**
- Create: `apps/api/src/application/use-cases/is-member-of.ts`
- Test: alongside.

**Interfaces:**
- Produces: `isMemberOf(viewerId: string, ownerId: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

True for an active subscription whose `current_period_end` is in the future. **False when the period has passed** — the spec's §9 limitation is that nothing renews yet, so an expired subscription must not grant access. False for `pending` and `cancelled`. False for an unrelated pair. False for a viewer and owner who are the same person.

- [ ] **Step 2: Run, watch fail, implement as one indexed query**

- [ ] **Step 3: Run the api suite once, then commit**

---

## Task 9: Pengaturan — payout and tiers

**Files:**
- Modify: `apps/web/src/user/apiClient.ts`, `apps/web/src/user/SettingsPage.tsx`
- Create: `apps/web/src/user/MembershipSettings.tsx`
- Test: alongside.

- [ ] **Step 1: Write the failing tests**

Connecting a payout account shows its status; **the tier editor is unavailable, with a Bahasa explanation, until a payout account is connected**; creating a tier lists it; deactivating removes it from the offer; a failed request produces a Bahasa sentence through `errorCopy.ts` and never `err.message`.

Keep DOM nodes out of any assertion that can fail.

- [ ] **Step 2: Run, watch fail, implement**

- [ ] **Step 3: Run the web suite and typecheck, then commit**

---

## Task 10: The profile offer and "Jadi anggota"

**Files:**
- Modify: `apps/web/src/user/ProfilePage.tsx`, `apps/web/src/user/apiClient.ts`
- Create: `apps/web/src/user/MembershipOffer.tsx`
- Test: alongside.

- [ ] **Step 1: Write the failing tests**

A profile with active tiers shows them with prices in rupiah; a profile without shows nothing at all (not an empty box); **a signed-out visitor pressing the button goes to Masuk**, not to a failed request; pressing it signed-in follows the returned invoice URL; **your own profile never offers you your own membership**; an already-active member sees that they are a member rather than a buy button.

- [ ] **Step 2: Run, watch fail, implement**

- [ ] **Step 3: Run the web suite and typecheck, then commit**

---

## Task 11: The gate — for the project owner

**Do not run this.** It binds ports, drives a browser, and — uniquely in this project — **moves real money through Xendit.**

Write `docs/superpowers/sdd/2026-08-20-memberships-5a/gate-checklist.md`, ordered so the unproven things come first:

- **Payout onboarding against real Xendit**, which no test can prove. Including: what a KYC-pending account looks like, and that a tier cannot be published before it completes.
- **A real payment end to end**, in Xendit's test mode, through to an active subscription.
- **The webhook**, including a deliberate redelivery — provider redelivery is normal, and idempotency has only ever been proven against a fake.
- That **community checkout still works**, because Task 7 edited a handler serving live money.
- The composer, feed and images from earlier phases still work.

---

## Self-Review

**Spec coverage:** §4 → Tasks 1, 2. §5 → Task 3. §6 → Tasks 4, 5, 6, 9, 10. §7 → Task 7. §8 → Task 8. §9 is a stated limitation, pinned by Task 8's expired-period test. §10 → the named tests in Tasks 2, 3, 7. §11 is out of scope.

**Type consistency:** `UserTierRow` (Task 1) is consumed unchanged in Tasks 2, 4, 5, 6. `UserSubscriptionRow` (Task 2) in Tasks 6, 7, 8. `USER_SUBSCRIPTION_EXTERNAL_ID_PREFIX` (Task 6) in Task 7. The wire tier shape `{ id, name, priceAmount, billingCycle }` is identical in Tasks 5, 9, 10.

**Known gap, deliberate and stated rather than hidden:** Tasks 4, 5, 9 and 10 carry test *names* and the rules they must satisfy rather than full test bodies — Tasks 9 and 10 because the markup does not exist yet, Tasks 4 and 5 because their shapes follow mechanically from Tasks 1-3. Every task touching money (2, 3, 6, 7, 8) carries real code. Phase 4's equivalent gap is where its two web tasks needed the most fix rounds; expect the same here.
