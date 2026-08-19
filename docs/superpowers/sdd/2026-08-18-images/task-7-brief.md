## Task 7: `MAX_POST_IMAGES` and `GET /users/limits`

**Files:**
- Modify: `apps/api/src/bootstrap.ts`
- Modify: `apps/api/src/routes/users.ts`
- Modify: `apps/api/.env.example`
- Test: `apps/api/src/routes/users.test.ts`, `apps/api/src/bootstrap.test.ts`

**Interfaces:**
- Produces: `GET /users/limits` → `{ maxPostImages: number }`, and `deps.maxPostImages`.

- [ ] **Step 1: Write the failing tests**

```ts
it("defaults to 5 when MAX_POST_IMAGES is unset", () => {
  expect(resolveMaxPostImages(undefined)).toBe(5);
});

it("refuses a malformed value loudly rather than becoming NaN", () => {
  expect(() => resolveMaxPostImages("banyak")).toThrow();
  expect(() => resolveMaxPostImages("0")).toThrow();
  expect(() => resolveMaxPostImages("-2")).toThrow();
});

it("GET /users/limits reports the configured maximum, without auth", async () => {
  const res = await app().request("/users/limits");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ maxPostImages: 5 });
});

it("a post carrying more than the maximum is a 400", async () => { /* six ids */ });
```

- [ ] **Step 2: Run, watch fail, implement**

`resolveMaxPostImages` lives beside the other env resolvers in `bootstrap.ts` and throws on anything that is not an integer ≥ 1. `/users/limits` is public and goes in `users.ts` **above** the `/:handle` routes.

`limits` is 6 characters of `[a-z]` — **it must join `RESERVED_HANDLES` too.** The guard from Task 4 will tell you if you forget.

- [ ] **Step 3: Run the api suite and commit**

---

