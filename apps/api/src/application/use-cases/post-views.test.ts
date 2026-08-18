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

  /**
   * Review round 1, I4: mutating `rows.length > limit` to `>= limit` left the
   * whole api workspace green — nothing exercised the boundary where the
   * repository returned EXACTLY `limit` rows with NO probe row attached (the
   * genuinely last page). Under that mutation an exactly-full last page
   * would report a non-null `nextCursor`, and "Muat lebih banyak" would fetch
   * an empty page — precisely what this function's own docstring says the
   * probe row exists to prevent. This is the `> limit` side of the boundary;
   * the test above ("drops the probe row...") is the `limit + 1` side.
   */
  it("an EXACTLY full page (no probe row) is the last page — nextCursor stays null", () => {
    const second: PostRow = { ...row, id: "bbbbbbbb-0000-4000-8000-000000000000", body: "dua" };

    const page = toFeedPage([row, second], 2);

    expect(page.posts).toHaveLength(2);
    expect(page.nextCursor === null).toBe(true);
  });

  it("a probe row beyond an exactly-full page never reaches the client", () => {
    const second: PostRow = { ...row, id: "bbbbbbbb-0000-4000-8000-000000000000", body: "dua" };
    const probe: PostRow = { ...row, id: "cccccccc-0000-4000-8000-000000000000", body: "TIDAK BOLEH TAMPIL" };

    const page = toFeedPage([row, second, probe], 2);

    expect(page.posts).toHaveLength(2);
    expect(page.posts.map((post) => post.body)).not.toContain("TIDAK BOLEH TAMPIL");
    expect(page.nextCursor === null).toBe(false);
  });
});
