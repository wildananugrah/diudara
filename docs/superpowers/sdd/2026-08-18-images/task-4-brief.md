## Task 4: `POST /users/media`, and reserving the handle

**Files:**
- Create: `apps/api/src/application/use-cases/upload-media.ts`
- Create: `apps/api/src/routes/media.ts`
- Modify: `apps/api/src/app.ts` (mount **after** `userRoutes`, like `postRoutes`)
- Modify: `apps/api/src/domain/handle.ts` (add `media` to `RESERVED_HANDLES`)
- Modify: `apps/api/src/bootstrap.ts`
- Test: `apps/api/src/routes/media.test.ts`, `apps/api/src/application/use-cases/upload-media.test.ts`

**Interfaces:**
- Consumes: `MediaRepositoryPort` (Task 1), `MediaStoragePort` (Task 2), `processUpload`/`MAX_UPLOAD_BYTES`/`UnsupportedImageError` (Task 3).
- Produces: `UploadMedia` with `execute(input: { ownerId: string; bytes: Uint8Array }): Promise<{ id: string; width: number; height: number }>`, and `mediaRoutes(deps)`.

- [ ] **Step 1: Reserve `media` first, and watch the existing guard explain why**

Before writing the route, run: `cd apps/api && bun test src/routes/users.test.ts -t "every literal /users segment"`
Expected: PASS today.

Add `"media"` to `RESERVED_HANDLES` in `apps/api/src/domain/handle.ts`, and add it to the five in the `isReservedHandle` test in `src/domain/handle.test.ts`. After Step 5 mounts the route, that guard would have failed without this — it is the reason the guard exists.

- [ ] **Step 2: Write the failing use-case test**

Cover: a successful upload stores **both** variants and returns the row's id and dimensions; an oversized input is refused **before** `processUpload` runs; and an `UnsupportedImageError` from the pipeline reaches the caller rather than being swallowed.

```ts
it("stores both variants and returns the new row", async () => {
  const storage = new FakeMediaStorageAdapter();
  const media = new DrizzleMediaRepository();
  const useCase = new UploadMedia(media, storage);

  const result = await useCase.execute({ ownerId: owner.id, bytes: await fixture("small.png") });

  expect(await storage.get(result.id, "full")).not.toBe(null);
  expect(await storage.get(result.id, "thumb")).not.toBe(null);
  expect(await media.findById(result.id)).not.toBe(null);
});

it("refuses a file over 10 MB without decoding it", async () => {
  const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
  await expect(useCase.execute({ ownerId: owner.id, bytes: oversized })).rejects.toBeInstanceOf(
    ValidationError
  );
  // Nothing reached the bucket.
  expect(storage.size).toBe(0);
});
```

- [ ] **Step 3: Run, watch fail, implement `UploadMedia`**

Order matters and is the point: check the size, run `processUpload`, `put` both variants, **then** insert the row. Bytes before the row means an interrupted upload leaves an unreferenced object — accepted and recorded in spec §8 — whereas a row before the bytes would mean a media id that 404s forever.

- [ ] **Step 4: Write the failing route test**

```ts
it("accepts a multipart upload and returns id, width and height", async () => {
  const form = new FormData();
  form.append("file", new Blob([await fixture("small.png")], { type: "image/png" }), "small.png");

  const res = await a.request("/users/media", {
    method: "POST",
    headers: authed(token),
    body: form,
  });

  expect(res.status).toBe(201);
  expect(Object.keys(await res.json()).sort()).toEqual(["height", "id", "width"]);
});

it("requires auth", async () => {
  const res = await a.request("/users/media", { method: "POST", body: new FormData() });
  expect(res.status).toBe(401);
});

it("rejects a text file with 400 and Bahasa copy naming the working formats", async () => {
  const form = new FormData();
  form.append("file", new Blob([await fixture("not-an-image.txt")], { type: "image/png" }), "x.png");

  const res = await a.request("/users/media", { method: "POST", headers: authed(token), body: form });

  expect(res.status).toBe(400);
  // The lie in `type` above is deliberate: the header decides, not the client.
  expect((await res.json()).error).toMatch(/JPG, PNG, WebP/);
});
```

- [ ] **Step 5: Implement the route and mount it**

`app.route("/users", mediaRoutes(deps))` in `app.ts`, **after** `userRoutes` — the same mount-order rule Task 2 of Phase 3 established, and `routes/posts.test.ts` pins it.

- [ ] **Step 6: Run the api suite**

Run: `cd apps/api && bun test`
Expected: 0 fail. If `every literal /users segment a handle could shadow is in RESERVED_HANDLES` fails, Step 1 was skipped.

- [ ] **Step 7: Commit**

```bash
git commit -am "feat(api): POST /users/media, and reserve the media handle"
```

---

