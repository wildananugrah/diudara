## Task 9: `PostCard`'s media slot

**Files:**
- Modify: `apps/web/src/user/PostCard.tsx` (the slot goes between the body `<p>` at line 69 and the actions block at line 72)
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/user/PostCard.test.tsx`

- [ ] **Step 1: Write the failing tests**

Thumbnails are what the feed loads; `width`/`height` are set as attributes so the row reserves space and the feed does not reflow as images arrive; `alt` is empty (`alt=""`) because there is no alt text in this phase and inventing one from the body would be worse than none; one, three and five images each render.

- [ ] **Step 2: Run, watch fail, implement, style at 390px and 1440px**

- [ ] **Step 3: Run the web suite, typecheck, and commit**

---

