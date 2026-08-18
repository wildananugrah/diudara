## Task 6: Posts on the profile

**Files:**
- Modify: `apps/web/src/user/ProfilePage.tsx` + its test

**Interfaces:**
- Consumes: `PostFeed`, `listUserPosts`, `getSessionUser`.

- [ ] **Step 1: Write the failing test**

Cover:
- a profile renders that person's posts below the existing header
- signed out, the posts still render — `listUserPosts` goes through `publicGet`
- an empty list renders honest Bahasa copy, not a spinner
- on **your own** profile the posts carry `Edit` and `Hapus`; on someone else's they do not
- a failed post load does **not** blank the profile header that already loaded — the same rule
  Jelajah's rails follow
- deleting from your own profile removes the row

- [ ] **Step 2: Add the feed to `ProfilePage`**

Hold the post state **separately** from the profile state, for the reason above.

- [ ] **Step 3: Prove it by mutation**

- Make a post-load failure set the profile state to an error → the "header survives" test must go red.
- Pass `isOwn` as `true` unconditionally → red.

Restore; paste outputs.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(web): a profile shows that person's posts"
```

---

