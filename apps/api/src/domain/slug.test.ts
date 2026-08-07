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

  it("folds diacritics to plain letters, including mid-word", () => {
    // A trailing accent is forgiving — the stray hyphen gets stripped anyway —
    // so these cases put the accent inside the word, where a naive NFKD pass
    // would emit "n-on-o" instead of "nono".
    expect(slugify("Ñoño Ünïcodé")).toBe("nono-unicode");
    expect(slugify("Café Señor Niño")).toBe("cafe-senor-nino");
    expect(slugify("Komunitas Peternak Lelé & Nila")).toBe("komunitas-peternak-lele-nila");
  });

  it("drops emoji rather than turning them into separators", () => {
    expect(slugify("Kelas 🚀 Cuan")).toBe("kelas-cuan");
  });

  it("only ever produces slugs the shared slug schema accepts", () => {
    // slugify feeds public checkout URLs that are validated by
    // packages/shared's slug regex. If the two disagree, we generate links our
    // own validator rejects.
    const sharedSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const names = [
      "Kelas Bimbel Budi",
      "Ñoño Ünïcodé",
      "Kajian Online: Fiqih & Hadits!",
      "!!!",
      "日本語のみ",
      "Kelas 🚀 Cuan",
      "  --Halo--  ",
      "a".repeat(200),
    ];
    for (const name of names) {
      expect(slugify(name)).toMatch(sharedSlugPattern);
    }
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
