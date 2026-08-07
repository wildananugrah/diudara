import { describe, expect, it } from "bun:test";
import { slugify, resolveSlugCollision } from "./slug";

describe("slugify", () => {
  it("lowercases and hyphenates a normal name", () => {
    expect(slugify("Kelas Bimbel Budi")).toBe("kelas-bimbel-budi");
  });

  it("strips punctuation and collapses whitespace", () => {
    expect(slugify("  Kajian   Online: Fiqih & Hadits!  ")).toBe("kajian-online-fiqih-hadits");
  });

  it("removes leading and trailing hyphens", () => {
    expect(slugify("--Halo--")).toBe("halo");
  });

  it("falls back to 'komunitas' when nothing usable remains", () => {
    expect(slugify("!!!")).toBe("komunitas");
  });

  it("truncates very long names to 120 characters without a trailing hyphen", () => {
    const result = slugify("a".repeat(200));
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith("-")).toBe(false);
  });
});

describe("resolveSlugCollision", () => {
  it("returns the base slug when it is free", async () => {
    const result = await resolveSlugCollision("kelas-budi", async () => false);
    expect(result).toBe("kelas-budi");
  });

  it("appends -2 when the base is taken", async () => {
    const taken = new Set(["kelas-budi"]);
    const result = await resolveSlugCollision("kelas-budi", async (s) => taken.has(s));
    expect(result).toBe("kelas-budi-2");
  });

  it("keeps incrementing past consecutive collisions", async () => {
    const taken = new Set(["kelas-budi", "kelas-budi-2", "kelas-budi-3"]);
    const result = await resolveSlugCollision("kelas-budi", async (s) => taken.has(s));
    expect(result).toBe("kelas-budi-4");
  });
});
