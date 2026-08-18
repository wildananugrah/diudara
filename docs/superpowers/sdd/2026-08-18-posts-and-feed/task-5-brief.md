## Task 5: Beranda's two tabs, and composing, editing and deleting

**Files:**
- Create: `apps/web/src/user/PostComposer.tsx` + `PostComposer.test.tsx`
- Modify: `apps/web/src/user/BerandaPage.tsx` (currently an 18-line placeholder) + its test
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `PostFeed`, `listFeed`, `createPost`, `editPost`, `deletePost`, `MAX_POST_BODY_LENGTH` from `@diudara/shared`.
- Produces: `PostComposer` with props `{ initialBody?: string; submitLabel: string; onSubmit: (body: string) => Promise<void>; onCancel?: () => void }`.

- [ ] **Step 1: Write the failing composer test**

Cover:
- `Kirim` is disabled when empty, when whitespace-only, and when over the limit
- the counter shows `0/1000` initially — **assert the LITERAL 1000**, never the constant
- `maxLength` on the textarea equals the literal `1000`
- a successful submit clears the box
- **a failed submit keeps the text** and shows Bahasa copy — losing what someone typed is the worst
  available outcome
- while in flight the button is disabled and a second click fires nothing

- [ ] **Step 2: Write `PostComposer`**

Placeholder `Apa yang terjadi?`. Both the `maxLength` attribute and a `.slice(0, MAX_POST_BODY_LENGTH)`
in `onChange` — belt and braces, exactly as `JelajahPage` bounds `?q=`.

- [ ] **Step 3: Write the failing Beranda test**

Cover:
- `Untuk Anda` is the default tab and `Mengikuti` is the other
- the tab lives in the URL (`?tab=mengikuti`), so back/forward work and a link is shareable
- **signed out, `Mengikuti` shows `Masuk untuk melihat` with a link to `/masuk` and fires NO
  request** — mirroring how the profile's follow button behaves
- signed out, `Untuk Anda` still loads and renders posts
- the composer is **absent** when signed out
- a new post prepends to the visible list without a refetch
- `Hapus` on your own post asks for confirmation, and on confirm removes the row
- `Edit` opens the composer pre-filled, and saving updates the row in place and shows `diedit`

- [ ] **Step 4: Rewrite `BerandaPage`**

Replace the placeholder. Keep the `Jelajah` link in the empty state — it is the only answer to an
empty follow graph, and Mengikuti's empty state is exactly where someone needs it.

The tab and the signed-out branch are the two things worth writing out:

```tsx
import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import PostFeed from "./PostFeed";
import PostCard from "./PostCard";
import PostComposer from "./PostComposer";
import { createPost, isUserSignedIn, getSessionUser, listFeed } from "./apiClient";
import type { PostView } from "./apiClient";

type Tab = "untuk-anda" | "mengikuti";

export default function BerandaPage() {
  // The tab lives in the URL, not in component state: back and forward then work,
  // and a link to Mengikuti is shareable. `?tab=` absent means Untuk Anda, so the
  // bare `/beranda` is the default rather than a redirect.
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "mengikuti" ? "mengikuti" : "untuk-anda";
  const signedIn = isUserSignedIn();
  const ownHandle = getSessionUser()?.handle ?? null;
  const [prepended, setPrepended] = useState<PostView[]>([]);

  // Memoised on `tab` so PostFeed refetches when the tab changes and NOT on every
  // render. See PostFeed's note: without this the effect loops.
  const load = useCallback((before: string | null) => listFeed(tab, before), [tab]);

  return (
    <main className="user-page">
      <h1>Beranda</h1>

      <nav className="feed-tabs" aria-label="Jenis beranda">
        <button
          type="button"
          aria-current={tab === "untuk-anda"}
          onClick={() => setParams({})}
        >
          Untuk Anda
        </button>
        <button
          type="button"
          aria-current={tab === "mengikuti"}
          onClick={() => setParams({ tab: "mengikuti" })}
        >
          Mengikuti
        </button>
      </nav>

      {signedIn ? (
        <PostComposer
          submitLabel="Kirim"
          onSubmit={async (body) => {
            const created = await createPost(body);
            setPrepended((current) => [created, ...current]);
          }}
        />
      ) : null}

      {prepended.map((post) => (
        <PostCard key={post.id} post={post} isOwn={true} />
      ))}

      {/* Mengikuti needs a viewer the server can resolve, so signed out it says so
          rather than firing a request that can only 401 — the same choice the
          profile's follow button makes with "Masuk untuk mengikuti". */}
      {tab === "mengikuti" && !signedIn ? (
        <p className="signed-out-notice">
          <Link to="/masuk">Masuk untuk melihat</Link>
        </p>
      ) : (
        <PostFeed
          load={load}
          ownHandle={ownHandle}
          emptyMessage={
            tab === "mengikuti"
              ? "Belum ada kiriman dari orang yang Anda ikuti."
              : "Belum ada kiriman untuk ditampilkan."
          }
        />
      )}

      <p>
        Temukan orang untuk diikuti di <Link to="/jelajah">Jelajah</Link>.
      </p>
    </main>
  );
}
```

The `prepended` list above is the simplest correct way to show a just-created post without a
refetch, but it means a new post appears **twice** after a tab switch that refetches. Either clear
`prepended` when `tab` changes, or lift the list into `PostFeed` via an imperative handle — **pick
one and pin it with a test that posts, switches tab, switches back, and asserts the post appears
exactly once.** Do not leave both.

`onEdit` and `onDeleted` wiring is yours to complete: `PostCard` raises them, and Beranda must
update the row in place on an edit and remove it on a delete. The test list in Step 3 is what
defines "correct" here.

- [ ] **Step 5: Run the suite, then prove Beranda by mutation**

- Make the signed-out `Mengikuti` tab fetch instead of showing `Masuk untuk melihat` → red.
- Render the composer when signed out → red.
- Drop the `?tab=` URL sync and use component state → the URL test must go red.

Then **re-run Task 2's Step-10 mutation**: change `MAX_POST_BODY_LENGTH` from `1000` to `999` in
`packages/shared` and confirm tests now go red in **both** `apps/api` and `apps/web`. Restore; paste
all four outputs.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): Beranda's two tabs, and composing, editing and deleting"
```

---

