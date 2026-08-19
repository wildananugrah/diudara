## Task 8: The web client and the composer

**Files:**
- Modify: `apps/web/src/user/apiClient.ts`
- Modify: `apps/web/src/user/PostComposer.tsx`
- Create: `apps/web/src/user/MediaStrip.tsx`
- Test: `apps/web/src/user/PostComposer.test.tsx`, `apps/web/src/user/MediaStrip.test.tsx`

**Interfaces:**
- Consumes: `POST /users/media`, `GET /users/limits`.
- Produces: `uploadMedia(file: File)`, `getLimits()`, `MediaStrip`, and `mediaIds` on `createPost`/`editPost`.

- [ ] **Step 1: Write the failing tests**

```ts
it("Kirim is disabled while an upload is still in flight", async () => { /* ... */ });
it("a failed upload marks that image, keeps the text, and offers a retry", async () => { /* ... */ });
it("the add button disables at the limit", async () => { /* ... */ });
it("falls back to a default limit when GET /users/limits fails, and stays usable", async () => {
  // Spec §6: a composer that refuses to open because a config endpoint is down
  // is a worse product than one that offers a sixth photo and is told no.
});
it("the EDIT composer is seeded with the post's existing images", async () => { /* ... */ });
it("Batal discards images added during an edit", async () => { /* ... */ });
```

**Never put a DOM node on either side of an assertion that can fail** — compare identity through a helper returning a short string, as `BerandaPage.test.tsx`'s `isNode` does. A failing assertion holding a happy-dom node serialises until the OOM killer fires.

- [ ] **Step 2: Run, watch fail, implement**

- [ ] **Step 3: Run the web suite, typecheck, and commit**

---

