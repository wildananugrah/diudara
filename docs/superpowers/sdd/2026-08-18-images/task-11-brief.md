## Task 11: The gate — for the project owner

**Do not run this. It binds ports and drives a browser, and the project owner runs it.**

Extend `docs/superpowers/sdd/2026-08-18-posts-and-feed/gate-checklist.md` (or start a Phase 4 one) with:

- Attaching one photo, then five; the sixth is refused.
- A 6 MB photo on throttled network: the preview appears immediately, Kirim stays disabled until the upload finishes.
- A photo taken on an iPhone. **If it arrives as HEIC and is refused, note it — spec §9 says that is the first thing to revisit.**
- Editing a post to remove one image and add another; `· diedit` appears.
- The feed at 390px with five images on one post.
- **DevTools Network:** the image request goes to `/users/media/...` and is a 200, **not a 302 to a bucket**.
- An image still loads after the API restarts (it is in the bucket, not in memory — this is the check that catches a fake adapter running in production).

---

## Self-Review

**Spec coverage:** §4 → Task 1. §5 + §5.1 → Tasks 4, 5. §5.2 + §5.3 → Task 6. §5.4 → Task 4 Step 1. §6 → Task 7. §7 → Task 8. §8 → Tasks 6, 10. §9 → Task 3 (sharp, HEIC, EXIF) and Task 5 (bandwidth comment). §10 → Task 3. §11 → the named tests in Tasks 2, 3, 5, 6. §12 is limitations, nothing to build.

**Type consistency:** `MediaRow` (Task 1) is used unchanged in Tasks 4, 6, 10. `MediaStoragePort.get` returns `MediaObject | null` in Tasks 2, 5, 10. `processUpload` returns `ProcessedImage` in Tasks 3, 4. The wire shape `{ id, width, height }` is identical in Tasks 4, 6, 8, 9.

**Known gap, deliberate:** Task 8's and Task 9's steps carry test *names* and the rules they must follow rather than full test bodies, because both depend on the exact markup they are testing. Their implementers must still write the test first and watch it fail. Every server-side task carries real code.
