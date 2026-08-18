## Task 4: `PostFeed` — a paginated list with "Muat lebih banyak"

**Files:**
- Modify: `apps/web/src/user/apiClient.ts`
- Create: `apps/web/src/user/PostFeed.tsx` + `PostFeed.test.tsx`

**Interfaces:**
- Consumes: `PostCard` and `PostView` from Task 3.
- Produces: `FeedPage`; `listFeed(tab, before?)`, `listUserPosts(handle, before?)`, `createPost(body)`, `editPost(id, body)`, `deletePost(id)`; `PostFeed` with props `{ load: (before: string | null) => Promise<FeedPage>; emptyMessage: string; ownHandle: string | null; onEdit?: (post: PostView) => void; onDeleted?: (id: string) => void }`.

- [ ] **Step 1: Add the client functions**

In `apiClient.ts`, beside `listFollowers`:

```ts
export interface FeedPage {
  posts: PostView[];
  nextCursor: string | null;
}

/**
 * `untuk-anda` is PUBLIC, `mengikuti` is not — hence two different helpers for
 * one endpoint.
 *
 * `publicGet` sends the viewer's token when there is one and never clears the
 * session on a 401; `apiFetch` does clear it. `mengikuti` genuinely requires a
 * live session, so a 401 there means the token is dead and clearing it is right.
 * `untuk-anda` must keep working with no session at all, because `/beranda` is a
 * publicly reachable page.
 */
export function listFeed(tab: "untuk-anda" | "mengikuti", before?: string | null): Promise<FeedPage> {
  const params = new URLSearchParams({ tab });
  if (before !== undefined && before !== null) params.set("before", before);
  const path = `/users/feed?${params.toString()}`;
  return tab === "mengikuti"
    ? apiFetch<FeedPage>(path)
    : publicGet<FeedPage>(path, "gagal memuat kiriman");
}

export function listUserPosts(handle: string, before?: string | null): Promise<FeedPage> {
  const params = new URLSearchParams();
  if (before !== undefined && before !== null) params.set("before", before);
  const search = params.toString();
  return publicGet<FeedPage>(
    `/users/${encodeURIComponent(handle)}/posts${search === "" ? "" : `?${search}`}`,
    "gagal memuat kiriman"
  );
}

export function createPost(body: string): Promise<PostView> {
  return apiFetch<PostView>("/users/posts", { method: "POST", body: JSON.stringify({ body }) });
}

export function editPost(id: string, body: string): Promise<PostView> {
  return apiFetch<PostView>(`/users/posts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
}

export function deletePost(id: string): Promise<void> {
  return apiFetch<void>(`/users/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
}
```

- [ ] **Step 2: Pin the auth split in `apiClient.test.ts`**

Two tests, both asserting on the captured `fetch` call:

```ts
it("listFeed('untuk-anda') sends no Authorization when there is no session, and still resolves", async () => {
  // no setUserSession
  // assert: init.headers has no Authorization, and the promise resolves
});

it("listFeed('mengikuti') sends the viewer's Bearer token", async () => {
  setUserSession("jwt-abc", USER);
  // assert: Authorization === "Bearer jwt-abc"
});

it("listFeed('untuk-anda') sends the token when there IS a session", async () => {
  // publicGet attaches it; this is the header whose absence made the follow
  // button unreachable for every signed-in user in Phase 2.
});
```

- [ ] **Step 3: Write the failing `PostFeed` test**

Cover, with `global.fetch` replaced:
- an empty first page renders `emptyMessage` and **no** "Muat lebih banyak" button
- a page with `nextCursor` renders the button; clicking it appends and passes `before=<cursor>`
- when the second page returns `nextCursor: null` the button disappears
- **a failed "load more" keeps the posts already on screen** and shows Bahasa copy — the exact
  regression the final review of Phase 2 made a merge blocker
- the error text comes from `describeRequestFailure`, never the server's string (the
  `no-raw-server-errors` scan enforces this; make sure it actually covers your new file)
- clicking "Muat lebih banyak" twice quickly does not fire two requests

- [ ] **Step 4: Write `PostFeed`**

The state shape is the whole point, so here it is explicitly. `posts`, `nextCursor`, `loading` and
`error` are **four separate pieces of state, never one discriminated union** — a union forces an error
to replace the list, which is the regression the final review of Phase 2 made a merge blocker.

```tsx
import { useCallback, useEffect, useState } from "react";
import PostCard from "./PostCard";
import { describeRequestFailure } from "./errorCopy";
import type { FeedPage, PostView } from "./apiClient";

interface Props {
  /** `null` means "the first page". Identity matters: a changed `load` refetches from the top. */
  load: (before: string | null) => Promise<FeedPage>;
  emptyMessage: string;
  /** The signed-in viewer's handle, or `null` when signed out. Decides which rows get a menu. */
  ownHandle: string | null;
  onEdit?: (post: PostView) => void;
  onDeleted?: (id: string) => void;
}

export default function PostFeed({ load, emptyMessage, ownHandle, onEdit, onDeleted }: Props) {
  const [posts, setPosts] = useState<PostView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Held SEPARATELY from `posts`. A failed "load more" must leave what already
  // loaded on screen — Jelajah's two rails follow the same rule for the same
  // reason, and the final review of Phase 2 measured the alternative.
  const [error, setError] = useState<string | null>(null);
  const [firstPageLoaded, setFirstPageLoaded] = useState(false);

  const fetchPage = useCallback(
    async (before: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await load(before);
        setPosts((current) => (before === null ? page.posts : [...current, ...page.posts]));
        setNextCursor(page.nextCursor);
        setFirstPageLoaded(true);
      } catch (err: unknown) {
        setError(describeRequestFailure(err));
      } finally {
        setLoading(false);
      }
    },
    [load]
  );

  useEffect(() => {
    setPosts([]);
    setNextCursor(null);
    setFirstPageLoaded(false);
    void fetchPage(null);
  }, [fetchPage]);

  return (
    <div className="post-feed">
      {posts.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          isOwn={ownHandle !== null && post.author.handle === ownHandle}
          onEdit={onEdit}
          onDeleted={onDeleted}
        />
      ))}

      {firstPageLoaded && posts.length === 0 && !loading ? (
        <p className="empty">{emptyMessage}</p>
      ) : null}

      {error !== null ? <p className="feed-error">{error}</p> : null}

      {nextCursor !== null ? (
        <button type="button" disabled={loading} onClick={() => void fetchPage(nextCursor)}>
          {loading ? "Memuat..." : "Muat lebih banyak"}
        </button>
      ) : null}
    </div>
  );
}
```

**`load` must be memoised by the caller** (`useCallback`), or the `useEffect` refetches on every
render. Beranda's two tabs rely on that identity change to reload when the tab changes — one place
where a missing `useCallback` is a hang, not a slowdown, so pin it: a test that renders, waits, and
asserts exactly one request.

`disabled={loading}` is what makes a double-tap one request. Do not also add a ref guard; one
mechanism, tested.

- [ ] **Step 5: Run the suite, then prove it by mutation**

- Make the error branch replace `posts` with `[]` → the "keeps posts on screen" test must go red.
- Render the button unconditionally → red.
- Drop `before` from the second request → red.

Restore; paste outputs.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): PostFeed with keyset pagination"
```

---

