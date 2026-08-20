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

