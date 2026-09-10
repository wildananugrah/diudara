import { describe, expect, it } from "bun:test";
import {
  isReservedCommunitySlug,
  isValidCommunitySlug,
  slugifyCommunityName,
} from "./community-slug";

describe("slugifyCommunityName", () => {
  it("lowercases and hyphenates", () => {
    expect(slugifyCommunityName("Bimbel Matematika Pak Andi")).toBe("bimbel-matematika-pak-andi");
  });

  it("collapses runs of punctuation and whitespace into one hyphen", () => {
    expect(slugifyCommunityName("Kajian  &  Rohani!!")).toBe("kajian-rohani");
  });

  it("strips leading and trailing hyphens, so a name that starts with punctuation is still valid", () => {
    expect(slugifyCommunityName("  ***Kelas Desain***  ")).toBe("kelas-desain");
  });

  it("never ends in a hyphen after truncation", () => {
    // 60 chars is the column width; the cut must not leave a dangling separator.
    const long = `${"a".repeat(59)} tail`;
    const slug = slugifyCommunityName(long);
    expect(slug.length <= 60).toBe(true);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns an empty string when a name has nothing sluggable, rather than inventing one", () => {
    expect(slugifyCommunityName("!!! ???")).toBe("");
  });
});

describe("isValidCommunitySlug", () => {
  it("accepts lowercase, digits and hyphens between 3 and 60 characters", () => {
    expect(isValidCommunitySlug("bimbel-sbmptn")).toBe(true);
    expect(isValidCommunitySlug("abc")).toBe(true);
  });

  it("rejects the shapes that would break a URL or a column", () => {
    expect(isValidCommunitySlug("ab")).toBe(false);
    expect(isValidCommunitySlug("a".repeat(61))).toBe(false);
    expect(isValidCommunitySlug("Kelas")).toBe(false);
    expect(isValidCommunitySlug("kelas desain")).toBe(false);
  });
});

describe("isReservedCommunitySlug", () => {
  /**
   * `/komunitas/baru` is the create form, so a community slugged `baru` would
   * be permanently unreachable. `pengikut` and `mengikuti` are the second
   * segments of the existing `/:handleParam/pengikut` and `/mengikuti` routes:
   * react-router scores `/komunitas/:slug` and `/:handleParam/pengikut`
   * identically for the URL `/komunitas/pengikut` — one static segment and one
   * dynamic each — so which wins is decided by declaration order rather than
   * by intent. Reserving is cheaper than depending on that.
   */
  it("reserves the slugs that would collide with a real route", () => {
    expect(isReservedCommunitySlug("baru")).toBe(true);
    expect(isReservedCommunitySlug("pengikut")).toBe(true);
    expect(isReservedCommunitySlug("mengikuti")).toBe(true);
  });

  it("does not reserve an ordinary slug", () => {
    expect(isReservedCommunitySlug("bimbel-sbmptn")).toBe(false);
  });
});
