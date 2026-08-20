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

