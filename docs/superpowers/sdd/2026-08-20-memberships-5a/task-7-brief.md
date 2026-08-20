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

