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

