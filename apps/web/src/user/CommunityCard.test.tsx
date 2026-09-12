import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CommunityCard from "./CommunityCard";
import type { CommunityListRow } from "./apiClient";

afterEach(cleanup);

const ROW: CommunityListRow = {
  slug: "kelas-desain",
  name: "Kelas Desain",
  category: "Skill Digital",
  description: "Belajar desain dari nol.",
  memberCount: 12,
  tags: [],
  trending: false,
  price: null,
  live: null,
};

function renderCard(overrides: Partial<CommunityListRow> = {}) {
  return render(
    <MemoryRouter>
      <CommunityCard community={{ ...ROW, ...overrides }} />
    </MemoryRouter>
  );
}

describe("CommunityCard", () => {
  it("links the name to the community's own page", () => {
    renderCard();

    const link = screen.getByRole("link", { name: "Kelas Desain" });
    expect(link.getAttribute("href")).toBe("/komunitas/kelas-desain");
  });

  it("names the category", () => {
    renderCard();

    expect(screen.getByText("Skill Digital").textContent).toBe("Skill Digital");
  });

  it("counts the members in Bahasa Indonesia", () => {
    renderCard({ memberCount: 12 });

    expect(screen.getByText("12 anggota").textContent).toBe("12 anggota");
  });

  it("renders the description when there is one", () => {
    renderCard();

    expect(screen.getByText("Belajar desain dari nol.").textContent).toBe(
      "Belajar desain dari nol."
    );
  });

  it("omits the description entirely when there is none, rather than leaving an empty line", () => {
    const { container } = renderCard({ description: null });

    // The class, not the node: an empty <p> would still satisfy a text query
    // for "", and this is what actually distinguishes absent from blank.
    expect(container.querySelectorAll(".community-card-description").length).toBe(0);
  });

  it("shows Gratis when there is no active tier", () => {
    renderCard({ price: null });

    expect(screen.getByText("Gratis").textContent).toBe("Gratis");
  });

  it("shows the cheapest tier's price and billing cycle", () => {
    renderCard({ price: { amount: 149_000, billingCycle: "monthly" } });

    expect(screen.getByText("Rp 149.000 per bulan").textContent).toBe("Rp 149.000 per bulan");
  });

  it("shows a trending badge only when trending", () => {
    const { container: trending } = renderCard({ trending: true });
    expect(trending.querySelectorAll(".community-card-trending").length).toBe(1);
    cleanup();

    const { container: notTrending } = renderCard({ trending: false });
    expect(notTrending.querySelectorAll(".community-card-trending").length).toBe(0);
  });

  it("renders each tag as a chip, and no chip list when there are none", () => {
    const { container: withTags } = renderCard({ tags: ["desain", "ui"] });
    expect(screen.getByText("#desain").textContent).toBe("#desain");
    expect(screen.getByText("#ui").textContent).toBe("#ui");
    cleanup();

    const { container: withoutTags } = renderCard({ tags: [] });
    expect(withoutTags.querySelectorAll(".community-card-tags").length).toBe(0);
  });
});
