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
