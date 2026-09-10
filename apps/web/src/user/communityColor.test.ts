import { describe, expect, it } from "bun:test";
import { COMMUNITY_COLORS, COMMUNITY_INKS, communityColor, communityInk } from "./communityColor";

describe("communityColor", () => {
  it("is deterministic — the same slug always gets the same hue", () => {
    expect(communityColor("bimbel-sbmptn")).toBe(communityColor("bimbel-sbmptn"));
  });

  it("only ever returns a token from the palette, so a card cannot drift off-brand", () => {
    for (const slug of ["a", "bimbel-sbmptn", "kelas-desain", "zzz", "kajian-online"]) {
      expect(COMMUNITY_COLORS.includes(communityColor(slug))).toBe(true);
    }
  });

  it("spreads across the palette rather than collapsing onto one hue", () => {
    const slugs = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
    const distinct = new Set(slugs.map(communityColor));
    expect(distinct.size > 1).toBe(true);
  });

  it("handles an empty slug without throwing", () => {
    expect(COMMUNITY_COLORS.includes(communityColor(""))).toBe(true);
  });

  it("pairs an ink with every hue, so the tile's initial always has one", () => {
    expect(COMMUNITY_INKS.length).toBe(COMMUNITY_COLORS.length);
  });

  it("gives the same slug an ink from the palette's own pairing", () => {
    for (const slug of ["a", "bimbel-sbmptn", "kelas-desain", "zzz", ""]) {
      // Indexed off the COLOUR, which is unique in its array — the inks are
      // not (four hues take white), so an `indexOf` on those would find the
      // first match rather than this slug's own.
      const paired = COMMUNITY_INKS[COMMUNITY_COLORS.indexOf(communityColor(slug))];
      expect(communityInk(slug)).toBe(paired!);
    }
  });
});
