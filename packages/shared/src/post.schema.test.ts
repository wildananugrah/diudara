import { describe, expect, test } from "bun:test";
import {
  COMMUNITY_POST_TYPES,
  MAX_COMMENT_BODY_LENGTH,
  createCommentSchema,
  createCommunityPostSchema,
} from "./post.schema";

/** 15 September 2026, 16:00 WIB. */
const STARTS_AT = "2026-09-15T09:00:00.000Z";

const anEvent = { title: "Kelas tambahan", startsAt: STARTS_AT };

describe("createCommunityPostSchema", () => {
  test("accepts the three types shipped so far", () => {
    // Phase 3 ADDED `kegiatan`. This assertion read `["diskusi",
    // "pengumuman"]` through Phase 2, and the test below it asserted that
    // `kegiatan` was REJECTED — correct then, because no `community_event`
    // table existed and an event with no date has no cell to sit in. Phase 3
    // built the table, so the value is now valid and both assertions moved
    // with it. Updated deliberately per the programme's working agreement
    // rather than deleted.
    expect(COMMUNITY_POST_TYPES).toEqual(["diskusi", "pengumuman", "kegiatan"]);
    expect(createCommunityPostSchema.safeParse({ body: "halo semua", type: "diskusi" }).success).toBe(true);
    expect(createCommunityPostSchema.safeParse({ body: "halo semua", type: "pengumuman" }).success).toBe(true);
    expect(
      createCommunityPostSchema.safeParse({ body: "halo semua", type: "kegiatan", event: anEvent }).success
    ).toBe(true);
  });

  test("rejects a type a later phase owns", () => {
    expect(createCommunityPostSchema.safeParse({ body: "halo semua", type: "materi" }).success).toBe(false);
  });

  test("a kegiatan without an event is rejected", () => {
    // Without this, an event with no date reaches the calendar and has no
    // cell to sit in — the exact failure Phase 2 cited when it refused to
    // render `kegiatan` early.
    expect(createCommunityPostSchema.safeParse({ body: "halo semua", type: "kegiatan" }).success).toBe(false);
  });

  test("an event on any other type is rejected", () => {
    // The other half of the rule: a `diskusi` carrying event fields would
    // write a community_event row the feed card then renders on a discussion.
    for (const type of ["diskusi", "pengumuman"]) {
      expect(
        createCommunityPostSchema.safeParse({ body: "halo semua", type, event: anEvent }).success
      ).toBe(false);
    }
  });

  test("an event's endsAt must land after its startsAt", () => {
    const parse = (endsAt: string) =>
      createCommunityPostSchema.safeParse({
        body: "halo semua",
        type: "kegiatan",
        event: { ...anEvent, endsAt },
      }).success;
    expect(parse("2026-09-15T08:00:00.000Z")).toBe(false);
    // Equal is rejected too — the CHECK is `>`, and a Zod rule that let a
    // zero-length event through would turn a field error into a 500.
    expect(parse(STARTS_AT)).toBe(false);
    expect(parse("2026-09-15T11:00:00.000Z")).toBe(true);
  });

  test("an event's title is trimmed and may not be empty", () => {
    const parsed = createCommunityPostSchema.parse({
      body: "halo semua",
      type: "kegiatan",
      event: { ...anEvent, title: "  Kelas tambahan  " },
    });
    expect(parsed.event?.title).toBe("Kelas tambahan");
    expect(
      createCommunityPostSchema.safeParse({
        body: "halo semua",
        type: "kegiatan",
        event: { ...anEvent, title: "   " },
      }).success
    ).toBe(false);
  });

  test("an event's timestamps must be real instants", () => {
    expect(
      createCommunityPostSchema.safeParse({
        body: "halo semua",
        type: "kegiatan",
        event: { ...anEvent, startsAt: "besok sore" },
      }).success
    ).toBe(false);
  });

  test("defaults the type to diskusi", () => {
    const parsed = createCommunityPostSchema.parse({ body: "halo semua" });
    expect(parsed.type).toBe("diskusi");
  });

  test("trims the body and rejects an empty one", () => {
    expect(createCommunityPostSchema.parse({ body: "  halo  " }).body).toBe("halo");
    expect(createCommunityPostSchema.safeParse({ body: "   " }).success).toBe(false);
  });
});

describe("createCommentSchema", () => {
  test("trims, rejects empty, and rejects over the maximum", () => {
    expect(createCommentSchema.parse({ body: "  setuju  " }).body).toBe("setuju");
    expect(createCommentSchema.safeParse({ body: "" }).success).toBe(false);
    expect(createCommentSchema.safeParse({ body: "a".repeat(MAX_COMMENT_BODY_LENGTH + 1) }).success).toBe(false);
    expect(createCommentSchema.safeParse({ body: "a".repeat(MAX_COMMENT_BODY_LENGTH) }).success).toBe(true);
  });
});
