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
    authorHandle: "budi",
    authorDisplayName: "Budi",
    ...overrides,
  };
}

class FakePosts implements PostRepositoryPort {
  ownership: PostOwnership | null = null;
  created: string[] = [];
  updated: { id: string; body: string } | null = null;
  deleted: string[] = [];
  updateResult: PostRow | null = fakeRow();

  async create(_authorId: string, body: string): Promise<PostRow> {
    this.created.push(body);
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
    posts.ownership = { id: POST_ID, authorId: SOMEONE_ELSE, isDeleted: false };
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
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: true };
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
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false };
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
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false };
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
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false };
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
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false };
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
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false };
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
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false };
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
    posts.ownership = { id: POST_ID, authorId: AUTHOR, isDeleted: false };
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
