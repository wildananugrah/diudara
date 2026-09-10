import { describe, expect, test } from "bun:test";
import {
  COMMUNITY_POST_TYPES,
  MAX_COMMENT_BODY_LENGTH,
  createCommentSchema,
  createCommunityPostSchema,
} from "./post.schema";

describe("createCommunityPostSchema", () => {
  test("accepts the two types this phase ships", () => {
    expect(COMMUNITY_POST_TYPES).toEqual(["diskusi", "pengumuman"]);
    for (const type of COMMUNITY_POST_TYPES) {
      expect(createCommunityPostSchema.safeParse({ body: "halo semua", type }).success).toBe(true);
    }
  });

  test("rejects a type a later phase owns", () => {
    expect(createCommunityPostSchema.safeParse({ body: "halo semua", type: "kegiatan" }).success).toBe(false);
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
