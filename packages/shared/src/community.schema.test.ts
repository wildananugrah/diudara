import { describe, expect, it } from "bun:test";
import {
  COMMUNITY_CATEGORIES,
  MAX_COMMUNITY_DESCRIPTION_LENGTH,
  MAX_COMMUNITY_NAME_LENGTH,
  createCommunitySchema,
} from "./community.schema";

describe("createCommunitySchema", () => {
  it("accepts a minimal valid payload", () => {
    const parsed = createCommunitySchema.parse({
      name: "Bimbel Matematika Pak Andi",
      category: "Bimbel & Ujian",
    });
    expect(parsed.name).toBe("Bimbel Matematika Pak Andi");
    expect(parsed.description).toBe(undefined);
  });

  it("trims the name, so a padded submission cannot smuggle whitespace into a slug", () => {
    const parsed = createCommunitySchema.parse({
      name: "   Kelas Desain   ",
      category: "Skill Digital",
    });
    expect(parsed.name).toBe("Kelas Desain");
  });

  it("rejects a category outside the six", () => {
    const result = createCommunitySchema.safeParse({
      name: "Kelas Desain",
      category: "Olahraga",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a name past the column's length, rather than letting Postgres truncate or error", () => {
    const result = createCommunitySchema.safeParse({
      name: "a".repeat(MAX_COMMUNITY_NAME_LENGTH + 1),
      category: "Skill Digital",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a description past the column's length", () => {
    const result = createCommunitySchema.safeParse({
      name: "Kelas Desain",
      category: "Skill Digital",
      description: "a".repeat(MAX_COMMUNITY_DESCRIPTION_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it("names exactly the six categories the reference defines, in order", () => {
    expect(COMMUNITY_CATEGORIES.join(" | ")).toBe(
      "Bimbel & Ujian | Coaching Bisnis | Kajian & Rohani | Edukasi Finansial | Skill Digital | Kreator & Media"
    );
  });
});
