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

