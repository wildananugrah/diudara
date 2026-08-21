import { describe, expect, it } from "bun:test";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { MediaRepositoryPort, MediaRow } from "../ports/media-repository.port";
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

describe("CreatePost", () => {
  it("refuses an empty body", async () => {
    const posts = new FakePosts();
    await expect(
      new CreatePost(posts, new FakeMedia()).execute({ authorId: AUTHOR, body: "" })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a body that is only whitespace", async () => {
    const posts = new FakePosts();
    await expect(
      new CreatePost(posts, new FakeMedia()).execute({ authorId: AUTHOR, body: "   \n\t  " })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses a body over the limit — asserted against the LITERAL 1000", async () => {
    const posts = new FakePosts();
    const media = new FakeMedia();
    await expect(
      new CreatePost(posts, media).execute({ authorId: AUTHOR, body: "a".repeat(1001) })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      new CreatePost(posts, media).execute({ authorId: AUTHOR, body: "a".repeat(1000) })
    ).resolves.toBeDefined();
  });

  it("trims the body before storing it", async () => {
    const posts = new FakePosts();
    const view = await new CreatePost(posts, new FakeMedia()).execute({
      authorId: AUTHOR,
      body: "  halo  ",
    });
    expect(view.body).toBe("halo");
  });

  it("a post with no mediaIds carries an empty media list and claims nothing", async () => {
    const media = new FakeMedia();
    const view = await new CreatePost(new FakePosts(), media).execute({
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

    const view = await new CreatePost(new FakePosts(), media).execute({
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
      new CreatePost(posts, media).execute({
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
      new CreatePost(posts, new FakeMedia()).execute({
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
      new CreatePost(posts, media).execute({
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
      new CreatePost(posts, media).execute({
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
      new CreatePost(posts, media).execute({
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
      new CreatePost(posts, new FakeMedia()).execute({
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
      new CreatePost(posts, new FakeMedia()).execute({
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

    const view = await new CreatePost(posts, media).execute({
      authorId: AUTHOR,
      body: "halo",
      mediaIds: [FIRST_IMAGE],
      visibility: "members",
    });

    expect(view.membersOnly).toBe(true);
  });

  it("an omitted visibility defaults to public, unaffected by the no-image rule", async () => {
    const view = await new CreatePost(new FakePosts(), new FakeMedia()).execute({
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
      new EditPost(posts, new FakeMedia()).execute({
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
      new EditPost(posts, new FakeMedia()).execute({
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
      new EditPost(posts, new FakeMedia()).execute({
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

    const view = await new EditPost(posts, media).execute({
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
      new EditPost(posts, media).execute({
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
      new EditPost(posts, media).execute({
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

    const view = await new EditPost(posts, media).execute({
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

    const view = await new EditPost(posts, media).execute({
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

    const view = await new EditPost(posts, media).execute({
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
      new EditPost(posts, media).execute({
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
      new EditPost(posts, media).execute({
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

    const view = await new EditPost(posts, media).execute({
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

    const view = await new EditPost(posts, media).execute({
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
      new EditPost(posts, media).execute({
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

    const view = await new EditPost(posts, media).execute({
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
