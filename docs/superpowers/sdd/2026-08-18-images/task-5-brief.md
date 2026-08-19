## Task 5: Delivery — `GET /users/media/:id` and `/thumb`

**Files:**
- Modify: `apps/api/src/routes/media.ts`
- Test: `apps/api/src/routes/media.test.ts`

**Interfaces:**
- Consumes: `MediaStoragePort`, `MediaRepositoryPort`.
- Produces: the two GET routes.

- [ ] **Step 1: Write the failing tests**

```ts
it("streams the full image as bytes, with an image content type", async () => {
  const id = await uploadFixture(a, token, "small.png");

  const res = await a.request(`/users/media/${id}`);

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/webp");
  expect((await res.bytes()).length).toBeGreaterThan(0);
});

it("streams the thumbnail, and it is SMALLER than the full image", async () => {
  const id = await uploadFixture(a, token, "photo-with-gps.jpg");

  const full = await (await a.request(`/users/media/${id}`)).bytes();
  const thumb = await (await a.request(`/users/media/${id}/thumb`)).bytes();

  // Proves the two routes serve different variants rather than the same object
  // twice — an assertion on status alone passes against that bug.
  expect(thumb.length).toBeLessThan(full.length);
});

/**
 * Spec §5.1. This is the assertion the whole phase's shape exists to satisfy,
 * and Phase 6's paywall is built on it holding.
 */
it("PROXIES: never a redirect, and never a bucket hostname in any header", async () => {
  const id = await uploadFixture(a, token, "small.png");

  const res = await a.request(`/users/media/${id}`, { redirect: "manual" });

  expect(res.status).toBe(200);
  expect(res.status).not.toBe(302);
  expect(res.headers.get("location")).toBe(null);
  const headers = JSON.stringify([...res.headers.entries()]);
  expect(headers).not.toMatch(/biznetgio|amazonaws|s3\./i);
});

it("404s an unknown id", async () => {
  expect((await a.request("/users/media/8a1f0e6e-0000-4000-8000-000000000000")).status).toBe(404);
});

it("404s a row whose bytes are missing, rather than 500ing", async () => {
  const id = await uploadFixture(a, token, "small.png");
  await storage.remove(id);

  expect((await a.request(`/users/media/${id}`)).status).toBe(404);
});
```

- [ ] **Step 2: Run, watch fail, implement**

Both handlers: validate the id is a uuid (400 otherwise — the precedent is Phase 3's I3 ruling on malformed post ids), read the row, read the object, and return the bytes with `Content-Type: image/webp` and `Cache-Control: public, max-age=31536000, immutable`. The content is immutable because the id names one exact re-encoded artefact.

**Leave a comment at the top of both handlers** naming the line where Phase 6's entitlement check goes, and stating that a redirect here would defeat it.

- [ ] **Step 3: Run the api suite and commit**

```bash
git commit -am "feat(api): serve media by proxying the bytes, never a redirect"
```

---

