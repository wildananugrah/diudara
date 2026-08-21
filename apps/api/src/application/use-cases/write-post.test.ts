import { beforeEach, describe, expect, it } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { DatabaseExecutor } from "../../db/client";
import { db, sql } from "../../db/client";
import { appUsers, posts as postsTable, postMedia } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleMediaRepository } from "../../infrastructure/repositories/drizzle-media.repository";
import { DrizzlePostEditUnitOfWork } from "../../infrastructure/repositories/drizzle-post-edit-unit-of-work";
import { DrizzlePostRepository } from "../../infrastructure/repositories/drizzle-post.repository";
import { ArrivalLatch } from "../../test-support/arrival-latch";
import type { MediaRepositoryPort, MediaRow } from "../ports/media-repository.port";
import type { PostEditUnitOfWorkPort } from "../ports/post-edit-unit-of-work.port";
import type {
  PostOwnership,
  PostRepositoryPort,
  PostRow,
} from "../ports/post-repository.port";
import { CreatePost, DeletePost, EditPost } from "./write-post";

const POST_ID = "aaaaaaaa-0000-4000-8000-000000000000";
const OTHER_POST_ID = "bbbbbbbb-0000-4000-8000-000000000000";

function fakeRow(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: POST_ID,
    body: "halo",
    createdAt: new Date("2026-08-18T03:00:00.000Z"),
    editedAt: null,
    // Distinct from AUTHOR and SOMEONE_ELSE (below) — a fixture where the
    // author id happened to equal a viewer id would make a later gate test
    // pass for the wrong reason.
    authorId: "33333333-0000-4000-8000-000000000000",
    visibility: "public",
    authorHandle: "budi",
    authorDisplayName: "Budi",
    ...overrides,
  };
}

class FakePosts implements PostRepositoryPort {
  ownership: PostOwnership | null = null;
  created: string[] = [];
  updated: { id: string; body: string; visibility?: string } | null = null;
  deleted: string[] = [];
  updateResult: PostRow | null = fakeRow();

  async create(_authorId: string, body: string, visibility?: string): Promise<PostRow> {
    this.created.push(body);
    return fakeRow({ body, visibility: visibility ?? "public" });
  }
  async ownershipOf(): Promise<PostOwnership | null> {
    return this.ownership;
  }
  /**
   * No real lock semantics in a synchronous fake — there is nothing for a
   * SECOND caller to block on inside one `bun:test` process. The DB-backed
   * concurrency tests below (`EditPost against a real transaction`) are what
   * prove the row lock itself; this fake exists so `EditPost`'s ORDER of
   * operations (lock, then check, then write) is still provable against
   * fakes exactly as `ownershipOf` was before it.
   */
  async lockForEdit(): Promise<PostOwnership | null> {
    return this.ownership;
  }
  /** Barrier two's read (`MediaEntitlement`); the write path never calls it. */
  async gatingOf() {
    return null;
  }
  /**
   * Mirrors the real repository's "omitted visibility leaves it alone"
   * contract (Task 5): when `visibility` is `undefined` the returned row
   * keeps whatever `updateResult` already carried, rather than collapsing to
   * some fixed default — a fake that always returned "public" here would let
   * "an omitted visibility leaves an edit alone" pass for the wrong reason.
   */
  async updateBody(id: string, body: string, visibility?: string): Promise<PostRow | null> {
    this.updated = { id, body, visibility };
    if (this.updateResult === null) return null;
    return { ...this.updateResult, body, visibility: visibility ?? this.updateResult.visibility };
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

/**
 * An in-memory media repository that really implements `claim`'s contract —
 * release everything currently on the post, then re-attach the given ids in
 * order. A recording-only double would let "removing an image unclaims it"
 * pass without any state ever changing, which is the exact thing spec §11
 * says must be asserted as an intermediate state.
 *
 * `deletes` is recorded but never expected to fire: nothing on the edit path
 * may delete a media row (spec §8 — removal unclaims, and the worker's sweep
 * is the only thing that deletes).
 */
class FakeMedia implements MediaRepositoryPort {
  rows: MediaRow[] = [];
  claims: Array<{ postId: string; ids: string[] }> = [];
  deletes: string[] = [];

  seed(overrides: Partial<MediaRow> & { id: string; ownerId: string }): MediaRow {
    const row: MediaRow = {
      postId: null,
      position: 0,
      width: 1600,
      height: 900,
      byteSize: 123456,
      createdAt: new Date("2026-08-18T02:00:00.000Z"),
      ...overrides,
    };
    this.rows.push(row);
    return row;
  }

  async create(input: {
    id?: string;
    ownerId: string;
    width: number;
    height: number;
    byteSize: number;
  }): Promise<MediaRow> {
    return this.seed({ ...input, id: input.id ?? crypto.randomUUID() });
  }
  async findById(id: string): Promise<MediaRow | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }
  async findManyByIds(ids: string[]): Promise<MediaRow[]> {
    return this.rows.filter((row) => ids.includes(row.id));
  }
  /** Returns the number actually claimed, exactly as the real repository does — a
      row that has vanished since the ownership check is simply not counted. */
  async claim(postId: string, ids: string[]): Promise<number> {
    this.claims.push({ postId, ids: [...ids] });
    for (const row of this.rows) {
      if (row.postId === postId) row.postId = null;
    }
    let claimed = 0;
    ids.forEach((id, position) => {
      const row = this.rows.find((candidate) => candidate.id === id);
      if (row !== undefined) {
        row.postId = postId;
        row.position = position;
        claimed += 1;
      }
    });
    return claimed;
  }
  async listForPost(postId: string): Promise<MediaRow[]> {
    return this.rows
      .filter((row) => row.postId === postId)
      .sort((left, right) => left.position - right.position);
  }
  async listForPosts(postIds: string[]): Promise<MediaRow[]> {
    return this.rows
      .filter((row) => row.postId !== null && postIds.includes(row.postId))
      .sort((left, right) => left.position - right.position);
  }
  async listUnclaimedBefore(): Promise<MediaRow[]> {
    return [];
  }
  async deleteIfUnclaimed(id: string): Promise<boolean> {
    this.deletes.push(id);
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row === undefined || row.postId !== null) return false;
    this.rows = this.rows.filter((candidate) => candidate.id !== id);
    return true;
  }
}

const AUTHOR = "11111111-0000-4000-8000-000000000000";
const SOMEONE_ELSE = "22222222-0000-4000-8000-000000000000";
const FIRST_IMAGE = "cccccccc-0000-4000-8000-000000000000";
const SECOND_IMAGE = "dddddddd-0000-4000-8000-000000000000";

/**
 * `CreatePost` and `EditPost` both take a `PostEditUnitOfWorkPort` now
 * (Task 5 fix rounds 1 and 2) rather than the two repositories directly.
 * Every existing test in this file constructs one against the SAME fakes it
 * already builds — this just runs `work` inline, exactly as
 * `fakeJoinRequestUnitOfWork` and friends do in `bootstrap.test.ts` — so
 * every assertion already written against `posts.created` / `posts.updated`
 * / `media.claims` keeps meaning what it always meant. Real transactional
 * behaviour (the row lock, the rollback on both paths) is proved separately,
 * against a real Postgres transaction, in the `— real transaction` describe
 * blocks below.
 */
function postWriteUnitOfWorkFor(
  posts: PostRepositoryPort,
  media: MediaRepositoryPort
): PostEditUnitOfWorkPort {
  return { run: (work) => work({ posts, media }) };
}

function createPostFor(posts: PostRepositoryPort, media: MediaRepositoryPort): CreatePost {
  return new CreatePost(postWriteUnitOfWorkFor(posts, media));
}

function editPostFor(posts: PostRepositoryPort, media: MediaRepositoryPort): EditPost {
  return new EditPost(postWriteUnitOfWorkFor(posts, media));
}

describe("CreatePost", () => {
  it("refuses an empty body", async () => {
    const posts = new FakePosts();
    await expect(
      createPostFor(posts, new FakeMedia()).execute({ authorId: AUTHOR, body: "" })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a body that is only whitespace", async () => {
    const posts = new FakePosts();
    await expect(
      createPostFor(posts, new FakeMedia()).execute({ authorId: AUTHOR, body: "   \n\t  " })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a body over the limit — asserted against the LITERAL 1000", async () => {
    const posts = new FakePosts();
    const media = new FakeMedia();
    await expect(
      createPostFor(posts, media).execute({ authorId: AUTHOR, body: "a".repeat(1001) })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createPostFor(posts, media).execute({ authorId: AUTHOR, body: "a".repeat(1000) })
    ).resolves.toBeDefined();
  });

  it("trims the body before storing it", async () => {
    const posts = new FakePosts();
    const view = await createPostFor(posts, new FakeMedia()).execute({
      authorId: AUTHOR,
      body: "  halo  ",
    });
    expect(view.body).toBe("halo");
  });

  it("a post with no mediaIds carries an empty media list and claims nothing", async () => {
    const media = new FakeMedia();
    const view = await createPostFor(new FakePosts(), media).execute({
      authorId: AUTHOR,
      body: "halo",
    });

    expect(view.media).toEqual([]);
    expect(media.claims).toEqual([]);
  });

  it("claims the given media under the new post, in the order given", async () => {
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR });
    media.seed({ id: SECOND_IMAGE, ownerId: AUTHOR });

    const view = await createPostFor(new FakePosts(), media).execute({
      authorId: AUTHOR,
      body: "halo",
      mediaIds: [SECOND_IMAGE, FIRST_IMAGE],
    });

    expect(media.claims).toEqual([{ postId: POST_ID, ids: [SECOND_IMAGE, FIRST_IMAGE] }]);
    expect(view.media.map((image) => image.id)).toEqual([SECOND_IMAGE, FIRST_IMAGE]);
  });

  it("refuses media owned by someone else — and does NOT create the post", async () => {
    const posts = new FakePosts();
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: SOMEONE_ELSE });

    await expect(
      createPostFor(posts, media).execute({
        authorId: AUTHOR,
        body: "halo",
        mediaIds: [FIRST_IMAGE],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(posts.created).toEqual([]);
    expect(media.claims).toEqual([]);
  });

  it("refuses an id no media row has ever had", async () => {
    const posts = new FakePosts();
    await expect(
      createPostFor(posts, new FakeMedia()).execute({
        authorId: AUTHOR,
        body: "halo",
        mediaIds: [FIRST_IMAGE],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(posts.created).toEqual([]);
  });

  it("refuses media already claimed by another post — no post may steal it", async () => {
    const posts = new FakePosts();
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR, postId: OTHER_POST_ID });

    await expect(
      createPostFor(posts, media).execute({
        authorId: AUTHOR,
        body: "halo",
        mediaIds: [FIRST_IMAGE],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(posts.created).toEqual([]);
  });

  /**
   * `mediaIds` is the complete desired list, and one row can hold only one
   * `position`. The same id twice would therefore claim the row once and
   * silently return a post with fewer images than were asked for — a
   * disagreement between request and result, which is precisely what the
   * whole-list semantics exist to rule out.
   */
  it("refuses the same image listed twice", async () => {
    const posts = new FakePosts();
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR });

    await expect(
      createPostFor(posts, media).execute({
        authorId: AUTHOR,
        body: "halo",
        mediaIds: [FIRST_IMAGE, FIRST_IMAGE],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(posts.created).toEqual([]);
  });

  /**
   * **The sweep's race, made LOUD.** Final whole-branch review, Important 4:
   * `requireAttachable` reads the rows, the orphan sweep deletes one of them a
   * moment later, and `claim` — which used to return nothing — attached one
   * fewer row than it was given and said nothing at all. The author got a post
   * back holding fewer photos than they sent, with no error anywhere.
   *
   * A `ConflictError` and not silence: the request cannot be completed as
   * asked, and the person can act on it (upload the photo again). The post row
   * does already exist by this point — the honest cost of not making the write
   * and the claim one unit of work, which is a separate, recorded decision.
   */
  it("refuses loudly when a claim attaches fewer rows than it was given", async () => {
    const posts = new FakePosts();
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR });
    const seen = media.findManyByIds.bind(media);
    // The sweep wins the race: the row is there for the ownership check and
    // gone by the time `claim` runs.
    media.findManyByIds = async (ids: string[]) => {
      const rows = await seen(ids);
      media.rows = media.rows.filter((row) => row.id !== FIRST_IMAGE);
      return rows;
    };

    await expect(
      createPostFor(posts, media).execute({
        authorId: AUTHOR,
        body: "halo",
        mediaIds: [FIRST_IMAGE],
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  /**
   * Spec §7: a members-only post with no image locks nothing, so the server
   * refuses to create one — checked against the mediaIds this CALL is
   * producing, which is `[]` here explicitly.
   */
  it("refuses to create a members-only post with no image — the lock would protect nothing", async () => {
    const posts = new FakePosts();
    await expect(
      createPostFor(posts, new FakeMedia()).execute({
        authorId: AUTHOR,
        body: "halo",
        mediaIds: [],
        visibility: "members",
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(posts.created).toEqual([]);
  });

  /**
   * `mediaIds` omitted entirely means the same thing as `[]` on CREATE
   * (unlike on edit, where omitted means "leave the images alone" — there is
   * nothing to leave alone yet). Both must be refused the same way.
   */
  it("refuses a members-only post whose mediaIds is omitted entirely, not just empty", async () => {
    const posts = new FakePosts();
    await expect(
      createPostFor(posts, new FakeMedia()).execute({
        authorId: AUTHOR,
        body: "halo",
        visibility: "members",
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(posts.created).toEqual([]);
  });

  it("creates a members-only post fine once at least one image is attached", async () => {
    const posts = new FakePosts();
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR });

    const view = await createPostFor(posts, media).execute({
      authorId: AUTHOR,
      body: "halo",
      mediaIds: [FIRST_IMAGE],
      visibility: "members",
    });

    expect(view.membersOnly).toBe(true);
  });

  it("an omitted visibility defaults to public, unaffected by the no-image rule", async () => {
    const view = await createPostFor(new FakePosts(), new FakeMedia()).execute({
      authorId: AUTHOR,
      body: "halo",
    });

    expect(view.membersOnly).toBe(false);
  });
});

describe("EditPost", () => {
  it("404s an id that never existed", async () => {
    const posts = new FakePosts();
    posts.ownership = null;
    await expect(
      editPostFor(posts, new FakeMedia()).execute({
        editorId: AUTHOR,
        postId: POST_ID,
        body: "baru",
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("403s someone else's post — and does NOT write", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: SOMEONE_ELSE, isDeleted: false, visibility: "public" };
    await expect(
      editPostFor(posts, new FakeMedia()).execute({
        editorId: AUTHOR,
        postId: POST_ID,
        body: "baru",
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(posts.updated === null).toBe(true);
  });

  it("404s a deleted post", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: true, visibility: "public" };
    await expect(
      editPostFor(posts, new FakeMedia()).execute({
        editorId: AUTHOR,
        postId: POST_ID,
        body: "baru",
      })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * The ONE clause that separates `PATCH` from `POST` (spec §5.2). Without
   * "or already claimed by this same post", every edit would reject its own
   * existing images and no post could ever be edited while keeping a photo.
   */
  it("may keep the post's OWN existing media", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "public" };
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR, postId: POST_ID });

    const view = await editPostFor(posts, media).execute({
      editorId: AUTHOR,
      postId: POST_ID,
      body: "halo lagi",
      mediaIds: [FIRST_IMAGE],
    });

    expect(view.media.map((image) => image.id)).toEqual([FIRST_IMAGE]);
  });

  it("refuses media claimed by a DIFFERENT post — and does NOT write the body", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "public" };
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR, postId: OTHER_POST_ID });

    await expect(
      editPostFor(posts, media).execute({
        editorId: AUTHOR,
        postId: POST_ID,
        body: "baru",
        mediaIds: [FIRST_IMAGE],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(posts.updated === null).toBe(true);
    expect(media.claims).toEqual([]);
  });

  it("refuses another person's unclaimed media", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "public" };
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: SOMEONE_ELSE });

    await expect(
      editPostFor(posts, media).execute({
        editorId: AUTHOR,
        postId: POST_ID,
        body: "baru",
        mediaIds: [FIRST_IMAGE],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(posts.updated === null).toBe(true);
  });

  /**
   * An OMITTED `mediaIds` is not an empty one. `mediaIds: []` is a caller
   * saying "no images"; leaving the key out is a caller saying nothing about
   * images at all — a text-only edit — and must not silently strip a post's
   * photos.
   */
  it("leaves the images alone when mediaIds is omitted entirely", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "public" };
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR, postId: POST_ID });

    const view = await editPostFor(posts, media).execute({
      editorId: AUTHOR,
      postId: POST_ID,
      body: "hanya teks yang berubah",
    });

    expect(media.claims).toEqual([]);
    expect(view.media.map((image) => image.id)).toEqual([FIRST_IMAGE]);
  });

  it("an explicit empty mediaIds removes every image", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "public" };
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR, postId: POST_ID });

    const view = await editPostFor(posts, media).execute({
      editorId: AUTHOR,
      postId: POST_ID,
      body: "tanpa foto",
      mediaIds: [],
    });

    expect(view.media).toEqual([]);
    expect(await media.findById(FIRST_IMAGE)).toMatchObject({ postId: null });
  });

  /**
   * Spec §8 and §11: removal UNCLAIMS, it never deletes. Asserting only that
   * the image left the post would pass equally well against an implementation
   * that dropped the row and the objects on the spot — so the row's surviving
   * `postId: null` and the fact that NOTHING was asked to delete are both
   * asserted here.
   *
   * **The bytes are checked through `media.deletes`, not through a storage
   * probe.** Final whole-branch review, Minor 7: this test used to build a
   * `FakeMediaStorageAdapter`, put two objects in it and assert they were still
   * there — two lines that cannot fail, because `EditPost` holds no storage
   * port at all (read its constructor) and so could not have removed them under
   * any implementation. `media.deletes` is the guard that can actually fail: it
   * is the only route by which anything on this path could reach the bytes,
   * since the sweep deletes objects only for rows this list hands it.
   */
  it("removing an image unclaims its row and leaves the bytes in storage", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "public" };
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR, postId: POST_ID, position: 0 });
    media.seed({ id: SECOND_IMAGE, ownerId: AUTHOR, postId: POST_ID, position: 1 });

    const view = await editPostFor(posts, media).execute({
      editorId: AUTHOR,
      postId: POST_ID,
      body: "satu foto saja",
      mediaIds: [FIRST_IMAGE],
    });

    expect(view.media.map((image) => image.id)).toEqual([FIRST_IMAGE]);
    expect(await media.findById(SECOND_IMAGE)).toMatchObject({ postId: null });
    expect(media.deletes).toEqual([]);
  });

  it("refuses loudly when an edit's claim attaches fewer rows than it was given", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "public" };
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR });
    const seen = media.findManyByIds.bind(media);
    media.findManyByIds = async (ids: string[]) => {
      const rows = await seen(ids);
      media.rows = media.rows.filter((row) => row.id !== FIRST_IMAGE);
      return rows;
    };

    await expect(
      editPostFor(posts, media).execute({
        editorId: AUTHOR,
        postId: POST_ID,
        body: "halo",
        mediaIds: [FIRST_IMAGE],
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  /**
   * Spec §7, checked against the RESULTING state: `mediaIds: []` here means
   * the edit is producing zero images on a post whose visibility (left
   * unspecified) stays `members` — the exact trap a members-only post with
   * no image opens.
   */
  it("refuses to EDIT away the last image of a members-only post", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "members" };
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR, postId: POST_ID });

    await expect(
      editPostFor(posts, media).execute({
        editorId: AUTHOR,
        postId: POST_ID,
        body: "halo",
        mediaIds: [],
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(posts.updated).toBe(null);
    expect(media.claims).toEqual([]);
  });

  /**
   * The test that keeps the rule usable (spec §7, brief): unlocking and
   * clearing images must be doable in ONE edit, or a creator needs two edits
   * to undo one mistake. Checked against what THIS call produces — `public`
   * and `[]` together — not the `members` the row still holds when the call
   * starts.
   */
  it("allows removing the last image once the post is public again, in the same edit", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "members" };
    posts.updateResult = fakeRow({ visibility: "members" });
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR, postId: POST_ID });

    const view = await editPostFor(posts, media).execute({
      editorId: AUTHOR,
      postId: POST_ID,
      body: "halo",
      mediaIds: [],
      visibility: "public",
    });

    expect(view.membersOnly).toBe(false);
    expect(view.media).toEqual([]);
  });

  /**
   * `.optional()` on `visibility` is load-bearing (posts.ts:52's comment
   * makes the same point about `mediaIds`): an edit that says nothing about
   * visibility must leave a members-only post members-only, never silently
   * un-gate it. `updateResult` stands in for the row the real repository
   * would hand back — still `members`, because nothing here asked to change
   * it.
   */
  it("an omitted visibility on an edit leaves a members-only post members-only", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "members" };
    posts.updateResult = fakeRow({ visibility: "members" });
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR, postId: POST_ID });

    const view = await editPostFor(posts, media).execute({
      editorId: AUTHOR,
      postId: POST_ID,
      body: "hanya teks yang berubah",
    });

    expect(view.membersOnly).toBe(true);
    expect(posts.updated?.visibility).toBe(undefined);
  });

  /**
   * The row's CURRENT media, not the request, is what the check must read
   * when `mediaIds` is omitted: this post already carries no images, and an
   * edit that flips it to `members` while saying nothing about images must
   * still be refused.
   */
  it("refuses flipping to members-only when the post currently has no images and mediaIds is omitted", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "public" };
    const media = new FakeMedia();

    await expect(
      editPostFor(posts, media).execute({
        editorId: AUTHOR,
        postId: POST_ID,
        body: "halo",
        visibility: "members",
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(posts.updated).toBe(null);
  });

  /**
   * The mirror image of the test above: the post already carries an image,
   * so flipping it to `members` without mentioning `mediaIds` at all must be
   * ALLOWED — spec §7's "flipping public to locked is allowed, not blocked".
   */
  it("flips a post to members-only fine when it already carries an image, mediaIds omitted", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false, visibility: "public" };
    const media = new FakeMedia();
    media.seed({ id: FIRST_IMAGE, ownerId: AUTHOR, postId: POST_ID });

    const view = await editPostFor(posts, media).execute({
      editorId: AUTHOR,
      postId: POST_ID,
      body: "sekarang khusus anggota",
      visibility: "members",
    });

    expect(view.membersOnly).toBe(true);
    expect(view.media.map((image) => image.id)).toEqual([FIRST_IMAGE]);
    expect(media.claims).toEqual([]);
  });
});

describe("DeletePost", () => {
  it("is idempotent on an already-deleted post", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: "p", authorId: AUTHOR, isDeleted: true, visibility: "public" };
    await new DeletePost(posts).execute({ deleterId: AUTHOR, postId: "p" });
    expect(posts.deleted).toEqual(["p"]);
  });

  it("403s someone else's post — and does NOT delete", async () => {
    const posts = new FakePosts();
    posts.ownership = { id: "p", authorId: SOMEONE_ELSE, isDeleted: false, visibility: "public" };
    await expect(
      new DeletePost(posts).execute({ deleterId: AUTHOR, postId: "p" })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(posts.deleted).toEqual([]);
  });
});

/**
 * Task 5 fix round 1 (spec §7, review Major finding). `EditPost`'s use-case
 * tests above prove the RULE against fakes; these prove the FIX — a row lock
 * inside one transaction — actually closes the two concrete paths a review
 * traced from the un-transacted version of this file to a `members` post
 * with zero images:
 *
 *   1. Two concurrent edits on the same post (`the invariant survives
 *      concurrent edits` below) — proved against the REAL
 *      `DrizzlePostEditUnitOfWork`, exactly as production wires it.
 *   2. A single edit whose own `claim` fails after `updateBody` already
 *      committed (`a failed claim rolls the visibility write back with it`
 *      below) — no concurrency machinery needed for this one at all. Proved
 *      through a REAL `EditPost.execute()` call and a genuinely thrown
 *      `ConflictError`, via a thin wrapper around `DrizzleMediaRepository`
 *      that injects the exact race `requireFullyClaimed`'s own docstring
 *      names (a row vanishing between the ownership check and the claim) —
 *      the same technique the fake-based tests above use for the identical
 *      race, now against real rows. That wrapper opens its OWN transaction
 *      rather than going through `DrizzlePostEditUnitOfWork`, so it proves
 *      `EditPost`'s own ordering (write, then claim, inside one transaction)
 *      rather than that specific class; `drizzle-post-edit-unit-of-work.test.ts`
 *      proves the SAME rollback property directly against
 *      `DrizzlePostEditUnitOfWork` itself, which this file's wrapper does
 *      not touch.
 *
 * A FAKE unit of work (used everywhere above) cannot prove either: fakes
 * mutate in place with no commit/rollback, and a single `bun:test` process
 * has no second connection to race.
 */
/**
 * Shared by both `— real transaction` describe blocks below (fix rounds 1
 * and 2 prove the identical property — a failed claim must not leave a
 * write standing — on two different entry points, so the seeding and the
 * race-injection wrapper are one copy, not two that could drift).
 */
let realTxSeedCounter = 0;

async function seedRealUser() {
  realTxSeedCounter += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: `postuow${realTxSeedCounter}`,
      email: `postuow${realTxSeedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: `Post UoW ${realTxSeedCounter}`,
      bio: null,
    })
    .returning();
  return row!;
}

async function currentVisibilityAndMediaCount(
  postId: string
): Promise<{ visibility: string; mediaCount: number }> {
  const [row] = await db.select().from(postsTable).where(eq(postsTable.id, postId));
  const claimed = await db.select().from(postMedia).where(eq(postMedia.postId, postId));
  return { visibility: row!.visibility, mediaCount: claimed.length };
}

/**
 * `DrizzleMediaRepository.findManyByIds` (called by `requireAttachable`,
 * BEFORE `claim`), wrapped to delete the row it just found the instant
 * after reading it — the orphan sweep's exact timing, forced rather than
 * hoped for. The delete runs on `tx`, the SAME transaction `claim` will
 * run its own SAVEPOINT inside, so by the time `claim`'s UPDATE reaches
 * that row it is gone and `claimed` comes back short.
 */
function raceDeletingMedia(tx: DatabaseExecutor): MediaRepositoryPort {
  const real = new DrizzleMediaRepository(tx);
  return {
    create: (input) => real.create(input),
    findById: (id) => real.findById(id),
    async findManyByIds(ids) {
      const rows = await real.findManyByIds(ids);
      await tx.delete(postMedia).where(inArray(postMedia.id, ids));
      return rows;
    },
    claim: (postId, ids) => real.claim(postId, ids),
    listForPost: (postId) => real.listForPost(postId),
    listForPosts: (postIds) => real.listForPosts(postIds),
    listUnclaimedBefore: (cutoff, limit) => real.listUnclaimedBefore(cutoff, limit),
    deleteIfUnclaimed: (id) => real.deleteIfUnclaimed(id),
  };
}

describe("EditPost — real transaction (Task 5 fix round 1)", () => {
  beforeEach(resetDatabase);

  /** One author, one post carrying exactly one image, both real rows. */
  async function seedPublicPostWithOneImage(): Promise<{
    authorId: string;
    postId: string;
    mediaId: string;
  }> {
    const posts = new DrizzlePostRepository(db);
    const media = new DrizzleMediaRepository(db);
    const author = await seedRealUser();
    const post = await posts.create(author.id, "asli", "public");
    const image = await media.create({ ownerId: author.id, width: 10, height: 10, byteSize: 1 });
    await media.claim(post.id, [image.id]);
    return { authorId: author.id, postId: post.id, mediaId: image.id };
  }

  /**
   * Path 2. No `ArrivalLatch`, no `Promise.all` — a single sequential
   * request, because that is the whole point: this needs no concurrency at
   * all to reach the forbidden state under the pre-fix code.
   */
  it("a failed claim rolls the visibility write back with it — no invariant left broken", async () => {
    const { authorId, postId, mediaId } = await seedPublicPostWithOneImage();
    const raceUnitOfWork: PostEditUnitOfWorkPort = {
      run: (work) => db.transaction((tx) => work({ posts: new DrizzlePostRepository(tx), media: raceDeletingMedia(tx) })),
    };

    await expect(
      new EditPost(raceUnitOfWork).execute({
        editorId: authorId,
        postId,
        body: "sekarang khusus anggota",
        mediaIds: [mediaId],
        visibility: "members",
      })
    ).rejects.toBeInstanceOf(ConflictError);

    // Read through a FRESH connection, not `tx` (which no longer exists —
    // the transaction rolled back). If `updateBody`'s write had survived the
    // later `claim` failure, this would read "members".
    const after = await currentVisibilityAndMediaCount(postId);
    expect(after.visibility).toBe("public");
    expect(after.mediaCount).toBe(1);
  });

  /**
   * Path 1. Real concurrency, real `ArrivalLatch`, pool warmed first —
   * Phase 5b's own lesson, applied here: an unwarmed pair can measure
   * connection-level serialisation in the driver rather than the row lock
   * this test exists to prove. `PAIRS` independent posts race SIMULTANEOUSLY
   * (one genuine 2-way contest per post — flip-to-members vs. clear-the-
   * last-image — not `PAIRS` copies of the same request), so the assertion
   * is checked against every one of them, not against a single lucky
   * interleaving.
   *
   * MEASURED: at `PAIRS = 1` (a single pair, run repeatedly) the two
   * requests serialised through the lock every time on this database — the
   * SAME machine drizzle-payment-activation and the reminder-claim races
   * above run against — and the invariant held, but a single pair proves
   * only that ONE interleaving was safe. Raised to 20 simultaneous pairs (40
   * requests total, one shared latch) to put real scheduler and connection-
   * pool pressure behind the claim "the lock, not luck, is what closes this"
   * — and to observe BOTH orderings actually occur (see the assertion on
   * `outcomes` below), not just one repeated 20 times.
   */
  it("the invariant survives concurrent edits — flip-to-members racing clear-the-last-image", async () => {
    const PAIRS = 20;
    const seeded = await Promise.all(
      Array.from({ length: PAIRS }, () => seedPublicPostWithOneImage())
    );

    const contenders = PAIRS * 2;
    // WARMING THE POOL IS PART OF THE TEST, NOT SETUP NOISE — see
    // `drizzle-membership-reminder.repository.test.ts`'s own version of this
    // comment: `postgres.js` connects lazily, and an unwarmed pool measures
    // the driver queueing behind one live connection, not the database
    // arbitrating anything.
    await Promise.all(Array.from({ length: contenders }, () => sql`select 1`));
    const latch = new ArrivalLatch(contenders);

    const editPost = new EditPost(new DrizzlePostEditUnitOfWork(db));
    const outcomes = await Promise.all(
      seeded.flatMap(({ authorId, postId }) => [
        (async () => {
          await latch.arriveAndWait();
          try {
            await editPost.execute({
              editorId: authorId,
              postId,
              body: "sekarang khusus anggota",
              visibility: "members",
            });
            return "A-won" as const;
          } catch {
            return "A-refused" as const;
          }
        })(),
        (async () => {
          await latch.arriveAndWait();
          try {
            await editPost.execute({
              editorId: authorId,
              postId,
              body: "hapus foto terakhir",
              mediaIds: [],
            });
            return "B-won" as const;
          } catch {
            return "B-refused" as const;
          }
        })(),
      ])
    );

    expect(latch.arrived).toBe(contenders);

    // THE INVARIANT ITSELF, checked against every one of the PAIRS posts —
    // not against whichever one the test happened to look at.
    const finalStates = await Promise.all(seeded.map(({ postId }) => currentVisibilityAndMediaCount(postId)));
    for (const state of finalStates) {
      expect(state.visibility === "members" && state.mediaCount === 0).toBe(false);
    }

    // Real contention, not a foregone conclusion: both orderings occurred
    // somewhere across 20 independent pairs. A test where A always won (or
    // always lost) would be consistent with the requests never truly
    // overlapping at the database.
    expect(outcomes).toContain("A-won");
    expect(outcomes).toContain("B-won");
  });
});

/**
 * Task 5 fix round 2 (spec §7). `CreatePost` had the identical shape as
 * `EditPost`'s path 2 from fix round 1: `posts.create(..., visibility)`
 * committed BEFORE `media.claim(...)`, so a lost claim race on a
 * `visibility: "members"` create left the SAME forbidden state behind —
 * reached from the OTHER entry point, and never covered by round 1's tests,
 * which only ever drove `EditPost`.
 *
 * There is no concurrent-CREATE analogue of path 1: two callers cannot race
 * to create-then-claim the SAME post, because there is no post until
 * `posts.create` returns, and nothing else can address it before then. The
 * single-request test below is therefore the WHOLE proof for this path, as
 * the review asked for — no `ArrivalLatch`, no `Promise.all`.
 */
describe("CreatePost — real transaction (Task 5 fix round 2)", () => {
  beforeEach(resetDatabase);

  it("a failed claim on a members-only create leaves NO post row at all", async () => {
    const author = await seedRealUser();
    const media = new DrizzleMediaRepository(db);
    const image = await media.create({ ownerId: author.id, width: 10, height: 10, byteSize: 1 });
    const raceUnitOfWork: PostEditUnitOfWorkPort = {
      run: (work) =>
        db.transaction((tx) =>
          work({ posts: new DrizzlePostRepository(tx), media: raceDeletingMedia(tx) })
        ),
    };

    await expect(
      new CreatePost(raceUnitOfWork).execute({
        authorId: author.id,
        body: "khusus anggota, foto hilang",
        mediaIds: [image.id],
        visibility: "members",
      })
    ).rejects.toBeInstanceOf(ConflictError);

    // Read through a FRESH connection, not `tx` (which no longer exists —
    // the transaction rolled back). Before fix round 2, `posts.create` had
    // already committed by this point, so this would find exactly one row:
    // a `members` post with zero images, the exact forbidden state.
    const rows = await db.select().from(postsTable).where(eq(postsTable.authorId, author.id));
    expect(rows).toEqual([]);
  });
});
