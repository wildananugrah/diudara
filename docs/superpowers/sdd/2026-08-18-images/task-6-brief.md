## Task 6: `mediaIds` on create and edit, and the post projection

**Files:**
- Modify: `apps/api/src/application/use-cases/write-post.ts`
- Modify: `apps/api/src/application/use-cases/read-posts.ts`
- Modify: `apps/api/src/application/post-views.ts`
- Modify: `apps/api/src/routes/posts.ts`
- Test: `apps/api/src/routes/posts.test.ts`, `apps/api/src/application/use-cases/write-post.test.ts`

**Interfaces:**
- Consumes: `MediaRepositoryPort`.
- Produces: `media: { id: string; width: number; height: number }[]` on every post view.

- [ ] **Step 1: Write the failing tests**

The ones that matter, from spec §5.2 and §11:

```ts
it("attaches media to a new post, in the order given", async () => { /* ... */ });

it("refuses media that belongs to someone else", async () => {
  const mine = await uploadFixture(a, otherToken, "small.png");
  const res = await createPost(a, token, "halo", [mine]);
  expect(res.status).toBe(400);
});

it("refuses media already claimed by a DIFFERENT post", async () => { /* ... */ });

it("an edit may keep the post's OWN existing media", async () => {
  // The one clause that separates PATCH from POST. Without it every edit
  // rejects its own images.
  const id = await uploadFixture(a, token, "small.png");
  const post = await (await createPost(a, token, "halo", [id])).json();

  const res = await patchPost(a, token, post.id, { body: "halo lagi", mediaIds: [id] });

  expect(res.status).toBe(200);
  expect((await res.json()).media.map((m) => m.id)).toEqual([id]);
});

it("removing an image UNCLAIMS it rather than deleting it", async () => {
  const [a1, a2] = [await uploadFixture(...), await uploadFixture(...)];
  const post = await (await createPost(a, token, "halo", [a1, a2])).json();

  await patchPost(a, token, post.id, { body: "halo", mediaIds: [a1] });

  // Asserting only the post's shape would pass against an implementation that
  // deleted the bytes immediately — spec §11.
  expect(await mediaRepo.findById(a2)).toMatchObject({ postId: null });
  expect(await storage.get(a2, "full")).not.toBe(null);
});

it("an image-only change still sets editedAt", async () => {
  const post = await (await createPost(a, token, "halo", [first])).json();
  expect(post.editedAt).toBe(null);

  const res = await patchPost(a, token, post.id, { body: "halo", mediaIds: [second] });

  expect((await res.json()).editedAt).not.toBe(null);
});

it("keeps the projection closed", async () => {
  const post = await (await createPost(a, token, "halo", [id])).json();
  expect(Object.keys(post).sort()).toEqual([
    "author", "body", "createdAt", "editedAt", "id", "media",
  ]);
  expect(Object.keys(post.media[0]).sort()).toEqual(["height", "id", "width"]);
});
```

- [ ] **Step 2: Run, watch fail, implement**

`media` is fetched for a whole page of posts with **one** `listForPosts(postIds)` call and grouped in memory. A per-row query here would be 20 round trips per feed page.

- [ ] **Step 3: Run the api suite and commit**

```bash
git commit -am "feat(api): posts carry media, and an edit replaces the whole list"
```

---

