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
