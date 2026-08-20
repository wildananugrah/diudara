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

