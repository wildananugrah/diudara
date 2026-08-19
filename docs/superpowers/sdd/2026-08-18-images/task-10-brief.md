## Task 10: The orphan sweep

**Files:**
- Modify: `apps/worker/src/scheduled-passes.ts`
- Modify: `apps/worker/src/main.ts`
- Test: `apps/worker/src/scheduled-passes.test.ts`

- [ ] **Step 1: Write the failing tests**

Unclaimed and older than 24 hours is swept — row **and** both objects. Unclaimed but newer is left. Claimed is never touched, however old. A storage failure on one row does not abort the pass.

- [ ] **Step 2: Run, watch fail, implement**

Delete the objects **before** the row: the reverse order loses the id and leaks the bytes forever.

- [ ] **Step 3: Run the worker suite and commit**

---

