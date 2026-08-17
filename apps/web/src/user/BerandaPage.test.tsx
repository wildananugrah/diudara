import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import BerandaPage from "./BerandaPage";

afterEach(() => cleanup());

/**
 * Beranda has no feed yet (Phase 3 builds `PostCard` and the two tabs — see
 * `docs/superpowers/specs/2026-08-17-member-ui-design.md` §2/§8). This is an
 * HONEST placeholder, not a spinner: the brief is explicit that faking a
 * loading state for content that does not exist is worse than a sentence.
 */
describe("BerandaPage", () => {
  it("shows the empty-state copy, verbatim", () => {
    render(
      <MemoryRouter>
        <BerandaPage />
      </MemoryRouter>
    );

    expect(screen.getByText("Belum ada kiriman untuk ditampilkan.")).toBeTruthy();
    expect(screen.getByText(/Temukan orang untuk diikuti di/)).toBeTruthy();
  });

  it("links to Jelajah exactly once", () => {
    render(
      <MemoryRouter>
        <BerandaPage />
      </MemoryRouter>
    );

    const jelajahLinks = screen.getAllByRole("link", { name: "Jelajah" });
    expect(jelajahLinks.length).toBe(1);
    expect(jelajahLinks[0].getAttribute("href")).toBe("/jelajah");
  });

  it("never shows a loading indicator — there is nothing to load yet", () => {
    render(
      <MemoryRouter>
        <BerandaPage />
      </MemoryRouter>
    );

    expect(screen.queryAllByText("Memuat...").length).toBe(0);
  });
});
