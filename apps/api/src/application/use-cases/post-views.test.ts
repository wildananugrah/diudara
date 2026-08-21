import { describe, expect, it } from "bun:test";
import type { MediaRow } from "../ports/media-repository.port";
import type { PostRow } from "../ports/post-repository.port";
import { toFeedPage, toPostView } from "./post-views";

const row: PostRow = {
  id: "aaaaaaaa-0000-4000-8000-000000000000",
  body: "halo",
  createdAt: new Date("2026-08-18T03:00:00.000Z"),
  editedAt: null,
  authorId: "77777777-0000-4000-8000-000000000000",
  visibility: "public",
  authorHandle: "budi",
  authorDisplayName: "Budi",
};

/**
 * The set `toFeedPage` consults per row. Named rather than inlined as
 * `new Set()` at fourteen call sites: every test below that is not about the
 * paywall is asserting something that must hold with the gate OPEN, and the
 * name says so.
 */
const NOBODY_LOCKED: ReadonlySet<string> = new Set<string>();

/** The wire's complete key set, in sorted order. Literal, never the type. */
const POST_VIEW_KEYS = [
  "author",
  "body",
  "createdAt",
  "editedAt",
  "id",
  "lockedMediaCount",
  "media",
  "membersOnly",
];

const membersRow: PostRow = { ...row, visibility: "members" };

function mediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: "dddddddd-0000-4000-8000-000000000000",
    ownerId: "eeeeeeee-0000-4000-8000-000000000000",
    postId: row.id,
    position: 0,
    width: 1600,
    height: 900,
    byteSize: 123456,
    createdAt: new Date("2026-08-18T02:00:00.000Z"),
    ...overrides,
  };
}

describe("toPostView", () => {
  it("returns EXACTLY the wire keys, with the author nested", () => {
    const view = toPostView(row, [], false);

    expect(Object.keys(view).sort()).toEqual([
      "author",
      "body",
      "createdAt",
      "editedAt",
      "id",
      "lockedMediaCount",
      "media",
      "membersOnly",
    ]);
    expect(Object.keys(view.author).sort()).toEqual(["displayName", "handle"]);
  });

  it("gives a post with no images an EMPTY media array, never a missing key", () => {
    const view = toPostView(row, [], false);

    expect("media" in view).toBe(true);
    expect(view.media).toEqual([]);
  });

  /**
   * The projection is closed on the media entries too. `ownerId` would tell a
   * reader who uploaded an image independently of who posted it, `postId` and
   * `position` are internal bookkeeping, and `byteSize` is storage detail — a
   * media row carries all four, so mapping the row straight through would leak
   * every one of them.
   */
  it("returns EXACTLY id, width and height per image — never ownerId, postId, position or byteSize", () => {
    const view = toPostView(row, [mediaRow()], false);

    expect(view.media).toHaveLength(1);
    expect(Object.keys(view.media[0]!).sort()).toEqual(["height", "id", "width"]);
    expect(view.media[0]).toEqual({
      id: "dddddddd-0000-4000-8000-000000000000",
      width: 1600,
      height: 900,
    });
  });

  it("keeps the order the repository handed over — that order IS position", () => {
    const first = mediaRow({ id: "11111111-0000-4000-8000-000000000000", position: 0 });
    const second = mediaRow({ id: "22222222-0000-4000-8000-000000000000", position: 1 });

    const view = toPostView(row, [second, first], false);

    expect(view.media.map((m) => m.id)).toEqual([
      "22222222-0000-4000-8000-000000000000",
      "11111111-0000-4000-8000-000000000000",
    ]);
  });

  it("keeps editedAt as an explicit null so the key set never varies", () => {
    expect("editedAt" in toPostView(row, [], false)).toBe(true);
    expect(toPostView(row, [], false).editedAt === null).toBe(true);
  });

  it("serialises timestamps as ISO strings", () => {
    expect(toPostView(row, [], false).createdAt).toBe("2026-08-18T03:00:00.000Z");
  });

  /**
   * BARRIER ONE. A locked view must carry no media id AT ALL — not a partial
   * list, not an id with the url withheld. The id IS the url (`/users/media/:id`
   * is derived from it), so one id that survives this function is one gated
   * image published to a stranger.
   */
  it("a locked post carries no media, and says how many are behind the lock", () => {
    const mediaA = mediaRow({ id: "aaaaaaa1-0000-4000-8000-000000000000", position: 0 });
    const mediaB = mediaRow({ id: "aaaaaaa2-0000-4000-8000-000000000000", position: 1 });
    const mediaC = mediaRow({ id: "aaaaaaa3-0000-4000-8000-000000000000", position: 2 });

    const view = toPostView(membersRow, [mediaA, mediaB, mediaC], true);

    expect(view.media).toEqual([]);
    expect(view.membersOnly).toBe(true);
    expect(view.lockedMediaCount).toBe(3);
  });

  /**
   * `membersOnly` is a fact about the POST, not about this viewer's standing:
   * the author and every paying member need to see that their post is gated,
   * and they are exactly the people who are never locked.
   */
  it("an unlocked members-only post carries its media AND still says it is members-only", () => {
    const mediaA = mediaRow({ id: "aaaaaaa1-0000-4000-8000-000000000000" });

    const view = toPostView(membersRow, [mediaA], false);

    expect(view.media.map((m) => m.id)).toEqual(["aaaaaaa1-0000-4000-8000-000000000000"]);
    expect(view.membersOnly).toBe(true);
    expect(view.lockedMediaCount).toBe(0);
  });

  it("a public post says membersOnly false and hides nothing", () => {
    const view = toPostView(row, [mediaRow()], false);

    expect(view.membersOnly).toBe(false);
    expect(view.lockedMediaCount).toBe(0);
    expect(view.media).toHaveLength(1);
  });

  /**
   * The projection is closed in BOTH shapes, and IDENTICAL in both. A
   * spot-check — asserting only that `media` is empty — passes against a view
   * that leaked the ids under some other key, and that is the entire failure
   * mode of this phase (spec §10).
   */
  it("the wire projection is CLOSED and identical in both shapes", () => {
    const mediaA = mediaRow({ id: "aaaaaaa1-0000-4000-8000-000000000000" });

    expect(Object.keys(toPostView(membersRow, [mediaA], true)).sort()).toEqual(POST_VIEW_KEYS);
    expect(Object.keys(toPostView(row, [mediaA], false)).sort()).toEqual(POST_VIEW_KEYS);
  });

  /**
   * Not a restatement of the key-set test above: that one proves no NEW key
   * appeared, this one proves no media id survives anywhere inside the value —
   * a leaked id nested under an existing key (`author`, say) would pass both
   * the key-set assertion and an `expect(view.media).toEqual([])`.
   */
  it("a leaked media id cannot hide anywhere in a locked view", () => {
    const mediaA = mediaRow({ id: "aaaaaaa1-0000-4000-8000-000000000000" });

    const serialised = JSON.stringify(toPostView(membersRow, [mediaA], true));

    expect(serialised).not.toContain("aaaaaaa1-0000-4000-8000-000000000000");
  });
});

describe("toFeedPage", () => {
  it("returns a null nextCursor when the page is not full", () => {
    const page = toFeedPage([row], 20, [], NOBODY_LOCKED);

    expect(page.posts).toHaveLength(1);
    expect(page.nextCursor === null).toBe(true);
  });

  it("drops the probe row and points nextCursor at the LAST KEPT row", () => {
    const second: PostRow = { ...row, id: "bbbbbbbb-0000-4000-8000-000000000000", body: "dua" };
    const third: PostRow = { ...row, id: "cccccccc-0000-4000-8000-000000000000", body: "tiga" };

    const page = toFeedPage([row, second, third], 2, [], NOBODY_LOCKED);

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

    const page = toFeedPage([row, second], 2, [], NOBODY_LOCKED);

    expect(page.posts).toHaveLength(2);
    expect(page.nextCursor === null).toBe(true);
  });

  it("a probe row beyond an exactly-full page never reaches the client", () => {
    const second: PostRow = { ...row, id: "bbbbbbbb-0000-4000-8000-000000000000", body: "dua" };
    const probe: PostRow = { ...row, id: "cccccccc-0000-4000-8000-000000000000", body: "TIDAK BOLEH TAMPIL" };

    const page = toFeedPage([row, second, probe], 2, [], NOBODY_LOCKED);

    expect(page.posts).toHaveLength(2);
    expect(page.posts.map((post) => post.body)).not.toContain("TIDAK BOLEH TAMPIL");
    expect(page.nextCursor === null).toBe(false);
  });

  /**
   * The whole page's media arrives as ONE flat list — `listForPosts` is a
   * single query for the page, not one per row — so this function is what
   * decides which image belongs to which post. Getting the grouping wrong
   * would show one person's photo under another person's words.
   */
  it("groups a flat media list onto the right posts, each in its own order", () => {
    const second: PostRow = { ...row, id: "bbbbbbbb-0000-4000-8000-000000000000", body: "dua" };
    const media = [
      mediaRow({ id: "11111111-0000-4000-8000-000000000000", postId: row.id, position: 0 }),
      mediaRow({ id: "22222222-0000-4000-8000-000000000000", postId: second.id, position: 0 }),
      mediaRow({ id: "33333333-0000-4000-8000-000000000000", postId: row.id, position: 1 }),
    ];

    const page = toFeedPage([row, second], 2, media, NOBODY_LOCKED);

    expect(page.posts[0]!.media.map((m) => m.id)).toEqual([
      "11111111-0000-4000-8000-000000000000",
      "33333333-0000-4000-8000-000000000000",
    ]);
    expect(page.posts[1]!.media.map((m) => m.id)).toEqual([
      "22222222-0000-4000-8000-000000000000",
    ]);
  });

  it("gives a post with no media an empty array while its neighbour has images", () => {
    const second: PostRow = { ...row, id: "bbbbbbbb-0000-4000-8000-000000000000", body: "dua" };

    const page = toFeedPage([row, second], 2, [mediaRow({ postId: second.id })], NOBODY_LOCKED);

    expect(page.posts[0]!.media).toEqual([]);
    expect(page.posts[1]!.media).toHaveLength(1);
  });

  /**
   * The caller fetches media for every row it asked the repository for,
   * INCLUDING the probe row — slicing happens here, so it cannot know which
   * rows survive without duplicating the probe logic. The probe row's media
   * must therefore be dropped along with the probe row itself.
   */
  /**
   * The set names AUTHORS, not posts — one membership answer covers every post
   * that author has on the page — so the per-row question has to be BOTH
   * halves: is this row gated, and is its author locked for this viewer.
   */
  it("locks a gated row whose author is in the locked set", () => {
    const gated: PostRow = { ...row, visibility: "members" };

    const page = toFeedPage([gated], 20, [mediaRow()], new Set([row.authorId]));

    expect(page.posts[0]!.media).toEqual([]);
    expect(page.posts[0]!.lockedMediaCount).toBe(1);
  });

  /**
   * **The half a set of author ids alone would get wrong.** An author with one
   * gated post and one public post on the same page is IN the locked set
   * because of the gated one; consulting the set without re-reading
   * `visibility` would withhold the public post's images from everybody,
   * including a signed-out reader who is entitled to them.
   */
  it("a locked author's PUBLIC post keeps its media", () => {
    const gated: PostRow = { ...row, id: "bbbbbbbb-0000-4000-8000-000000000000", visibility: "members" };
    const media = [
      mediaRow({ id: "11111111-0000-4000-8000-000000000000", postId: row.id }),
      mediaRow({ id: "22222222-0000-4000-8000-000000000000", postId: gated.id }),
    ];

    const page = toFeedPage([row, gated], 20, media, new Set([row.authorId]));

    expect(page.posts[0]!.media.map((m) => m.id)).toEqual(["11111111-0000-4000-8000-000000000000"]);
    expect(page.posts[0]!.membersOnly).toBe(false);
    expect(page.posts[1]!.media).toEqual([]);
  });

  it("a gated row whose author is NOT locked keeps its media", () => {
    const gated: PostRow = { ...row, visibility: "members" };

    const page = toFeedPage([gated], 20, [mediaRow()], NOBODY_LOCKED);

    expect(page.posts[0]!.media).toHaveLength(1);
    expect(page.posts[0]!.membersOnly).toBe(true);
    expect(page.posts[0]!.lockedMediaCount).toBe(0);
  });

  it("drops the probe row's media along with the probe row", () => {
    const second: PostRow = { ...row, id: "bbbbbbbb-0000-4000-8000-000000000000", body: "dua" };
    const probe: PostRow = { ...row, id: "cccccccc-0000-4000-8000-000000000000", body: "tiga" };
    const media = [mediaRow({ id: "99999999-0000-4000-8000-000000000000", postId: probe.id })];

    const page = toFeedPage([row, second, probe], 2, media, NOBODY_LOCKED);

    expect(page.posts).toHaveLength(2);
    expect(page.posts.flatMap((post) => post.media)).toEqual([]);
  });
});
