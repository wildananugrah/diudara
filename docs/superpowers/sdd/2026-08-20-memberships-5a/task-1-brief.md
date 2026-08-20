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

