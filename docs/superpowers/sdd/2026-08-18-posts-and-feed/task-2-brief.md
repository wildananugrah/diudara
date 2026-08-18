## Task 2: Use cases, shared limits, and the API routes

**Files:**
- Modify: `packages/shared/src/auth.schema.ts`
- Create: `apps/api/src/application/use-cases/post-views.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/write-post.ts` + `.test.ts`
- Create: `apps/api/src/application/use-cases/read-posts.ts` + `.test.ts`
- Create: `apps/api/src/routes/posts.ts` + `.test.ts`
- Modify: `apps/api/src/bootstrap.ts`, `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `PostRepositoryPort`, `PostRow`, `PostOwnership` from Task 1; `UserRepositoryPort` (for handle → user); `encodeKeysetCursor`, `decodeKeysetCursor` from `../../domain/keyset-cursor`; `NotFoundError`, `ForbiddenError`, `ValidationError` from `../errors` (Step 0 adds `ForbiddenError`); `requireUserAuth`, `resolveViewerId` from `../http/user-auth.middleware`; `validate` middleware.
- Produces: `PostView`, `toPostView`, `toFeedPage`, `FeedPage`, `CreatePost`, `EditPost`, `DeletePost`, `ListFeed`, `ListUserPosts`, `postRoutes`.

- [ ] **Step 0: Add `ForbiddenError`**

`apps/api/src/application/errors.ts` has **no 403 class** — verified: it exports `ValidationError`
(400), `UnauthorizedError` (401), `NotFoundError` (404), `ConflictError` (409) and others, and
nothing maps to 403. Add one, matching the existing classes exactly:

```ts
export class ForbiddenError extends AppError {
  constructor(message = "forbidden") {
    super(message, 403);
  }
}
```

`errorHandler` already turns any `AppError` into `{ error: message }` with `err.status`, so no
handler change is needed. **Pin it**: a test asserting `new ForbiddenError().status === 403`, because
a 403 arriving as a 409 is exactly the kind of silent mis-mapping this project has paid for.

- [ ] **Step 1: Add the shared constant**

In `packages/shared/src/auth.schema.ts`, after `DEFAULT_FOLLOW_LIST_LIMIT` (line 82), following the
docstring style of the two constants above it. **Only `MAX_POST_BODY_LENGTH` goes here** — see the
note after the code block.

```ts
/**
 * Longest post body — **the ONE definition**, imported by the server that
 * refuses a longer one and by the client that must never send one.
 *
 * Same defect class as `MAX_EXPLORE_QUERY_LENGTH` above, which reached
 * production: a limit known only to the server put a raw English Zod message on
 * the screen. The composer's counter, its `maxLength`, and the route's validator
 * all read this.
 *
 * Tests on both sides assert the LITERAL `1000`; see `MAX_EXPLORE_QUERY_LENGTH`
 * for why never the constant.
 */
export const MAX_POST_BODY_LENGTH = 1000;
```

**The two page-size numbers stay in `apps/api`, not in `packages/shared`.** Declare them at the top
of `apps/api/src/routes/posts.ts`:

```ts
const DEFAULT_FEED_PAGE_SIZE = 20;
const MAX_FEED_PAGE_SIZE = 50;
```

`packages/shared` exists for a number **both sides read**, and the client reads neither of these: the
feed's paging is driven entirely by the opaque `nextCursor` the server hands back, so `apps/web` never
sends a `limit` and never needs to know the page size. A constant exported to a workspace that does
not import it is the shape of the `PAYMENT_GATEWAY_PROVIDER` flag this project already deleted once —
config for a decision nobody is making. If a later phase gives the client a reason to know the page
size, move it then, with the reason recorded.

`MAX_POST_BODY_LENGTH` is different, and is the one that belongs there: the composer's counter, its
`maxLength` attribute and the route's validator all read it, so a single edit must redden both
workspaces. That mutation is Task 2 Step 10 #3.

- [ ] **Step 2: Write the failing mapper test**

Create `apps/api/src/application/use-cases/post-views.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import type { PostRow } from "../ports/post-repository.port";
import { toFeedPage, toPostView } from "./post-views";

const row: PostRow = {
  id: "aaaaaaaa-0000-4000-8000-000000000000",
  body: "halo",
  createdAt: new Date("2026-08-18T03:00:00.000Z"),
  editedAt: null,
  authorHandle: "budi",
  authorDisplayName: "Budi",
};

describe("toPostView", () => {
  it("returns EXACTLY the wire keys, with the author nested", () => {
    const view = toPostView(row);

    expect(Object.keys(view).sort()).toEqual(["author", "body", "createdAt", "editedAt", "id"]);
    expect(Object.keys(view.author).sort()).toEqual(["displayName", "handle"]);
  });

  it("keeps editedAt as an explicit null so the key set never varies", () => {
    expect("editedAt" in toPostView(row)).toBe(true);
    expect(toPostView(row).editedAt === null).toBe(true);
  });

  it("serialises timestamps as ISO strings", () => {
    expect(toPostView(row).createdAt).toBe("2026-08-18T03:00:00.000Z");
  });
});

describe("toFeedPage", () => {
  it("returns a null nextCursor when the page is not full", () => {
    const page = toFeedPage([row], 20);

    expect(page.posts).toHaveLength(1);
    expect(page.nextCursor === null).toBe(true);
  });

  it("drops the probe row and points nextCursor at the LAST KEPT row", () => {
    const second: PostRow = { ...row, id: "bbbbbbbb-0000-4000-8000-000000000000", body: "dua" };
    const third: PostRow = { ...row, id: "cccccccc-0000-4000-8000-000000000000", body: "tiga" };

    const page = toFeedPage([row, second, third], 2);

    expect(page.posts.map((post) => post.body)).toEqual(["halo", "dua"]);
    expect(page.nextCursor).toBe("2026-08-18T03:00:00.000Z|bbbbbbbb-0000-4000-8000-000000000000");
  });
});
```

- [ ] **Step 3: Run it and watch it fail, then write the mappers**

Create `apps/api/src/application/use-cases/post-views.ts`:

```ts
import { encodeKeysetCursor } from "../../domain/keyset-cursor";
import type { PostRow } from "../ports/post-repository.port";

/**
 * A post as the wire sees it. The nesting happens HERE and nowhere else, so
 * "what a post looks like to a client" has one definition.
 */
export interface PostView {
  id: string;
  body: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601, or null on an unedited post — explicitly null, never absent, so the key set is stable. */
  editedAt: string | null;
  author: { handle: string; displayName: string };
}

export interface FeedPage {
  posts: PostView[];
  /** `null` means this was the last page. */
  nextCursor: string | null;
}

export function toPostView(row: PostRow): PostView {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
    author: { handle: row.authorHandle, displayName: row.authorDisplayName },
  };
}

/**
 * Turns `limit + 1` rows into a page of at most `limit`.
 *
 * THE PROBE ROW IS WHY: asking for one more than we intend to return is the only
 * way `nextCursor === null` can mean "there is nothing after this" rather than
 * "this page happened to come back full". Without it, every exhausted feed shows
 * a "Muat lebih banyak" button that fetches an empty page.
 */
export function toFeedPage(rows: PostRow[], limit: number): FeedPage {
  const kept = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = kept[kept.length - 1];
  return {
    posts: kept.map(toPostView),
    nextCursor:
      hasMore && last !== undefined
        ? encodeKeysetCursor({ timestamp: last.createdAt, id: last.id })
        : null,
  };
}
```

- [ ] **Step 4: Write the failing write-path tests**

Create `apps/api/src/application/use-cases/write-post.test.ts`. Use a hand-written in-memory fake of
`PostRepositoryPort` — this project does not use a mocking framework for ports.

```ts
import { describe, expect, it } from "bun:test";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type {
  PostOwnership,
  PostRepositoryPort,
  PostRow,
} from "../ports/post-repository.port";
import { CreatePost, DeletePost, EditPost } from "./write-post";

function fakeRow(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000000",
    body: "halo",
    createdAt: new Date("2026-08-18T03:00:00.000Z"),
    editedAt: null,
    authorHandle: "budi",
    authorDisplayName: "Budi",
    ...overrides,
  };
}

class FakePosts implements PostRepositoryPort {
  ownership: PostOwnership | null = null;
  updated: { id: string; body: string } | null = null;
  deleted: string[] = [];
  updateResult: PostRow | null = fakeRow();

  async create(_authorId: string, body: string): Promise<PostRow> {
    return fakeRow({ body });
  }
  async ownershipOf(): Promise<PostOwnership | null> {
    return this.ownership;
  }
  async updateBody(id: string, body: string): Promise<PostRow | null> {
    this.updated = { id, body };
    return this.updateResult;
  }
  async softDelete(id: string): Promise<void> {
    this.deleted.push(id);
  }
  async listGlobal(): Promise<PostRow[]> {
    return [];
  }
  async listFollowing(): Promise<PostRow[]> {
    return [];
  }
  async listByAuthor(): Promise<PostRow[]> {
    return [];
  }
}

const AUTHOR = "11111111-0000-4000-8000-000000000000";
const SOMEONE_ELSE = "22222222-0000-4000-8000-000000000000";

describe("CreatePost", () => {
  it("refuses an empty body", async () => {
    const posts = new FakePosts();
    await expect(new CreatePost(posts).execute({ authorId: AUTHOR, body: "" })).rejects.toBeInstanceOf(
      ValidationError
    );
  });

  it("refuses a body that is only whitespace", async () => {
    const posts = new FakePosts();
    await expect(
      new CreatePost(posts).execute({ authorId: AUTHOR, body: "   \n\t  " })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a body over the limit — asserted against the LITERAL 1000", async () => {
    const posts = new FakePosts();
    await expect(
      new CreatePost(posts).execute({ authorId: AUTHOR, body: "a".repeat(1001) })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      new CreatePost(posts).execute({ authorId: AUTHOR, body: "a".repeat(1000) })
    ).resolves.toBeDefined();
  });

  it("trims the body before storing it", async () => {
    const posts = new FakePosts();
    const view = await new CreatePost(posts).execute({ authorId: AUTHOR, body: "  halo  " });
    expect(view.body).toBe("halo");
  });
});

describe("EditPost", () => {
  it("404s an id that never existed", async () => {
    const posts = new FakePosts();
    posts.ownership = null;
    await expect(
      new EditPost(posts).execute({ editorId: AUTHOR, postId: "x", body: "baru" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("403s someone else's post — and does NOT write", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: "p", authorId: SOMEONE_ELSE, isDeleted: false };
    await expect(
      new EditPost(posts).execute({ editorId: AUTHOR, postId: "p", body: "baru" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(posts.updated === null).toBe(true);
  });

  it("404s a deleted post", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: "p", authorId: AUTHOR, isDeleted: true };
    await expect(
      new EditPost(posts).execute({ editorId: AUTHOR, postId: "p", body: "baru" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("DeletePost", () => {
  it("is idempotent on an already-deleted post", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: "p", authorId: AUTHOR, isDeleted: true };
    await new DeletePost(posts).execute({ deleterId: AUTHOR, postId: "p" });
    expect(posts.deleted).toEqual(["p"]);
  });

  it("403s someone else's post — and does NOT delete", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: "p", authorId: SOMEONE_ELSE, isDeleted: false };
    await expect(
      new DeletePost(posts).execute({ deleterId: AUTHOR, postId: "p" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(posts.deleted).toEqual([]);
  });
});
```

`ForbiddenError` is the class Step 0 adds. A 403 must not arrive as a 409, and the route tests in
Step 7 assert the status code, not the class.

- [ ] **Step 5: Write the write-path use cases**

Create `apps/api/src/application/use-cases/write-post.ts`:

```ts
import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { PostRepositoryPort } from "../ports/post-repository.port";
import { toPostView, type PostView } from "./post-views";

export { MAX_POST_BODY_LENGTH };

const EMPTY_MESSAGE = "kiriman tidak boleh kosong";
const TOO_LONG_MESSAGE = `kiriman maksimal ${MAX_POST_BODY_LENGTH} karakter`;
const NOT_YOURS_MESSAGE = "kiriman ini bukan milik Anda";

/**
 * Trims, then validates. In that order deliberately: a body of three spaces is
 * empty, and validating before trimming would accept it.
 */
function requireBody(raw: string): string {
  const body = raw.trim();
  if (body.length === 0) throw new ValidationError(EMPTY_MESSAGE);
  if (body.length > MAX_POST_BODY_LENGTH) throw new ValidationError(TOO_LONG_MESSAGE);
  return body;
}

export class CreatePost {
  constructor(private readonly posts: PostRepositoryPort) {}

  async execute(input: { authorId: string; body: string }): Promise<PostView> {
    const row = await this.posts.create(input.authorId, requireBody(input.body));
    return toPostView(row);
  }
}

export class EditPost {
  constructor(private readonly posts: PostRepositoryPort) {}

  async execute(input: { editorId: string; postId: string; body: string }): Promise<PostView> {
    const body = requireBody(input.body);
    // Ownership BEFORE the write, and a 403 that does not reveal the body:
    // returning 404 for someone else's post would make the id an existence
    // oracle, and 403 on a post you cannot see reveals nothing you could not
    // learn from the feed, where every post is public in this phase.
    const owned = await this.requireOwn(input.postId, input.editorId);
    if (owned.isDeleted) throw new NotFoundError("post not found");
    const row = await this.posts.updateBody(input.postId, body);
    if (row === null) throw new NotFoundError("post not found");
    return toPostView(row);
  }

  private async requireOwn(postId: string, actorId: string) {
    const owned = await this.posts.ownershipOf(postId);
    if (owned === null) throw new NotFoundError("post not found");
    if (owned.authorId !== actorId) throw new ForbiddenError(NOT_YOURS_MESSAGE);
    return owned;
  }
}

export class DeletePost {
  constructor(private readonly posts: PostRepositoryPort) {}

  /**
   * Idempotent: deleting an already-deleted post returns normally. A button that
   * errors when the state already matches what you asked for is worse than one
   * that agrees — the same ruling follow/unfollow made.
   */
  async execute(input: { deleterId: string; postId: string }): Promise<void> {
    const owned = await this.posts.ownershipOf(input.postId);
    if (owned === null) throw new NotFoundError("post not found");
    if (owned.authorId !== input.deleterId) throw new ForbiddenError(NOT_YOURS_MESSAGE);
    await this.posts.softDelete(input.postId);
  }
}
```

Note `EditPost` has a private `requireOwn` and `DeletePost` repeats the two checks inline. That is
deliberate: `EditPost` needs the returned `owned` to test `isDeleted`, `DeletePost` does not.
If you prefer one shared helper function at module scope, that is fine — do not create a base class.

- [ ] **Step 6: Write the read use cases and their tests**

Create `apps/api/src/application/use-cases/read-posts.ts`:

```ts
import { NotFoundError } from "../errors";
import type { KeysetCursor } from "../../domain/keyset-cursor";
import type { PostRepositoryPort } from "../ports/post-repository.port";
import type { UserRepositoryPort } from "../ports/user-repository.port";
import { normalizeHandle } from "../../domain/handle";
import { toFeedPage, type FeedPage } from "./post-views";

/**
 * The fallback when a caller passes no limit. `routes/posts.ts` always passes one,
 * so this only guards a direct call from a test or a future caller.
 */
const DEFAULT_FEED_PAGE_SIZE = 20;

export type FeedTab = "untuk-anda" | "mengikuti";

export class ListFeed {
  constructor(private readonly posts: PostRepositoryPort) {}

  /**
   * `viewerId` is REQUIRED for `mengikuti` and unused for `untuk-anda`. The route
   * is what enforces the 401, not this class — see `routes/posts.ts` for why the
   * two tabs differ in auth at all (`/beranda` is a publicly reachable page).
   */
  async execute(input: {
    tab: FeedTab;
    viewerId: string | null;
    limit?: number;
    before: KeysetCursor | null;
  }): Promise<FeedPage> {
    const limit = input.limit ?? DEFAULT_FEED_PAGE_SIZE;
    if (input.tab === "mengikuti") {
      if (input.viewerId === null) {
        throw new Error("ListFeed: mengikuti requires a viewer; the route must reject first");
      }
      const rows = await this.posts.listFollowing(input.viewerId, limit + 1, input.before);
      return toFeedPage(rows, limit);
    }
    const rows = await this.posts.listGlobal(limit + 1, input.before);
    return toFeedPage(rows, limit);
  }
}

export class ListUserPosts {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly posts: PostRepositoryPort
  ) {}

  async execute(input: {
    handle: string;
    limit?: number;
    before: KeysetCursor | null;
  }): Promise<FeedPage> {
    const user = await this.users.findByHandle(normalizeHandle(input.handle));
    if (!user) throw new NotFoundError("user not found");
    const limit = input.limit ?? DEFAULT_FEED_PAGE_SIZE;
    const rows = await this.posts.listByAuthor(user.id, limit + 1, input.before);
    return toFeedPage(rows, limit);
  }
}
```

**Check `normalizeHandle`'s import path** — `follow-user.ts` imports it; copy that import line
verbatim rather than guessing. Same for `UserRepositoryPort`'s path and `findByHandle`'s exact name.

Write `read-posts.test.ts` covering: `untuk-anda` calls `listGlobal` with `limit + 1`; `mengikuti`
calls `listFollowing`; an unknown handle throws `NotFoundError`; and the `limit + 1` is asserted as
the literal `21` when no limit is given.

- [ ] **Step 7: Write the failing route tests**

Create `apps/api/src/routes/posts.test.ts`. Copy how `users.test.ts` builds an app and issues
requests — read it first and match it exactly. Cover at minimum:

```
- POST /users/posts with no Authorization        -> 401
- POST /users/posts with a session               -> 201, body keys are exactly
                                                    ["author","body","createdAt","editedAt","id"]
- POST /users/posts with body ""                 -> 400
- POST /users/posts with 1001 chars              -> 400   (LITERAL 1001)
- GET  /users/feed?tab=untuk-anda  NO header     -> 200    <- §5.1, the whole reason the split exists
- GET  /users/feed?tab=mengikuti   NO header     -> 401    <- §5.1
- GET  /users/feed?tab=mengikuti   with header   -> 200
- GET  /users/feed?tab=nonsense                  -> 400
- GET  /users/feed?before=garbage                -> 400, NOT a silent restart at page 1
- GET  /users/feed?limit=999                     -> 400 or clamped to 50; assert which, LITERAL 50
- GET  /users/budi/posts           NO header     -> 200, author-scoped
- GET  /users/tidak-ada/posts                    -> 404
- PATCH /users/posts/:id  by the author          -> 200, editedAt non-null
- PATCH /users/posts/:id  by another user        -> 403
- DELETE /users/posts/:id by another user        -> 403
- DELETE /users/posts/:id twice by the author    -> 200 both times
- a deleted post is absent from GET /users/feed?tab=untuk-anda AND from GET /users/:handle/posts
```

- [ ] **Step 8: Write the router**

Create `apps/api/src/routes/posts.ts`. Mirror `routes/users.ts`: a Hono app with
`UserAuthVariables`, `requireAuth` applied **per route** (never `app.use("*")`), `validate()` for
bodies, a hand-rolled Zod parse for query params.

```ts
import { Hono } from "hono";
import { z } from "zod";
import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import { ValidationError } from "../application/errors";
import { decodeKeysetCursor, type KeysetCursor } from "../domain/keyset-cursor";
import { validate } from "../http/validate";
import {
  requireUserAuth,
  resolveViewerId,
  type UserAuthVariables,
} from "../http/user-auth.middleware";
import type { Dependencies } from "../bootstrap";
import type { FeedTab } from "../application/use-cases/read-posts";

const DEFAULT_FEED_PAGE_SIZE = 20;
const MAX_FEED_PAGE_SIZE = 50;

const postBodySchema = z.object({
  body: z.string().min(1).max(MAX_POST_BODY_LENGTH),
});

const feedQuerySchema = z.object({
  tab: z.enum(["untuk-anda", "mengikuti"]).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_FEED_PAGE_SIZE).optional(),
});

function parseFeedQuery(rawTab: string | undefined, rawLimit: string | undefined) {
  const parsed = feedQuerySchema.safeParse({
    ...(rawTab === undefined || rawTab === "" ? {} : { tab: rawTab }),
    ...(rawLimit === undefined || rawLimit === "" ? {} : { limit: rawLimit }),
  });
  if (!parsed.success) {
    throw new ValidationError(
      `permintaan tidak valid: tab harus untuk-anda atau mengikuti, dan limit 1-${MAX_FEED_PAGE_SIZE}`
    );
  }
  return {
    tab: (parsed.data.tab ?? "untuk-anda") as FeedTab,
    limit: parsed.data.limit ?? DEFAULT_FEED_PAGE_SIZE,
  };
}

/**
 * A malformed `?before=` is a 400, never "no cursor". Treating it as absent
 * restarts the list at page 1, so a "Muat lebih banyak" button with a corrupt
 * cursor loops for ever showing the same rows — see `keyset-cursor.ts`.
 */
function parseBefore(raw: string | undefined): KeysetCursor | null {
  if (raw === undefined || raw === "") return null;
  const cursor = decodeKeysetCursor(raw);
  if (cursor === null) throw new ValidationError("penanda halaman tidak valid");
  return cursor;
}

export function postRoutes(deps: Dependencies) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  const requireAuth = requireUserAuth(deps.userTokenIssuer, deps.userRepository);

  app.post("/posts", requireAuth, validate(postBodySchema), async (c) => {
    const input = c.get("validated") as { body: string };
    const view = await deps.createPost.execute({ authorId: c.get("userId"), body: input.body });
    return c.json(view, 201);
  });

  app.patch<"/posts/:id">("/posts/:id", requireAuth, validate(postBodySchema), async (c) => {
    const input = c.get("validated") as { body: string };
    const view = await deps.editPost.execute({
      editorId: c.get("userId"),
      postId: c.req.param("id"),
      body: input.body,
    });
    return c.json(view);
  });

  app.delete<"/posts/:id">("/posts/:id", requireAuth, async (c) => {
    await deps.deletePost.execute({ deleterId: c.get("userId"), postId: c.req.param("id") });
    return c.json({ deleted: true });
  });

  // §5.1: `untuk-anda` is PUBLIC and `mengikuti` requires a session. `/beranda`
  // is a publicly reachable page, so an auth-only feed endpoint would break a
  // page a signed-out visitor can open — the cross-layer shape this project
  // keeps finding. Hence `resolveViewerId` (which degrades to null) plus an
  // explicit 401 for the one tab that cannot work without a viewer.
  app.get("/feed", async (c) => {
    const { tab, limit } = parseFeedQuery(c.req.query("tab"), c.req.query("limit"));
    const before = parseBefore(c.req.query("before"));
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    if (tab === "mengikuti" && viewerId === null) {
      return c.json({ error: "masuk untuk melihat kiriman yang Anda ikuti" }, 401);
    }
    const page = await deps.listFeed.execute({ tab, viewerId, limit, before });
    return c.json(page);
  });

  app.get<"/:handle/posts">("/:handle/posts", async (c) => {
    const { limit } = parseFeedQuery(undefined, c.req.query("limit"));
    const before = parseBefore(c.req.query("before"));
    const page = await deps.listUserPosts.execute({
      handle: c.req.param("handle"),
      limit,
      before,
    });
    return c.json(page);
  });

  return app;
}
```

- [ ] **Step 9: Wire it up**

In `apps/api/src/bootstrap.ts`, construct `DrizzlePostRepository` and the five use cases and add them
to `Dependencies` — follow exactly how `followUser` / `listFollows` were added.

In `apps/api/src/app.ts`, beside the existing `app.route("/users", userRoutes(deps));`:

```ts
app.route("/users", postRoutes(deps));
```

**Two routers on one prefix is intentional** — it keeps `routes/users.ts` from growing again. Verify
by test that `GET /users/budi/posts` and `GET /users/budi/followers` BOTH still resolve; if
registration order shadows one, mount `postRoutes` first and pin the order with a test.

- [ ] **Step 10: Run the suite, then prove three things by mutation**

1. Change `parseBefore` to `return null` instead of throwing on a bad cursor → a test must go red.
2. Delete the `tab === "mengikuti" && viewerId === null` guard → a test must go red.
3. Change `MAX_POST_BODY_LENGTH` in `packages/shared` from `1000` to `999` → **tests in BOTH
   `apps/api` and `apps/web` must go red** (web will only have them after Task 5; note that and
   re-run this mutation at Task 5's end).

Restore each. Paste all outputs.

- [ ] **Step 11: Commit**

```bash
git add -A && git commit -m "feat(posts): use cases, shared limits, and the API routes"
```

---

