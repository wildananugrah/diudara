import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import SiaranPage from "./SiaranPage";

afterEach(() => cleanup());

/**
 * Siaran (Phase 7's real destination — see the member-UI spec §6/§8) has no
 * streaming re-pointed to it yet. An honest placeholder, not a spinner, for
 * the same reason BerandaPage.test.tsx gives.
 */
describe("SiaranPage", () => {
  it("shows the empty-state copy, verbatim", () => {
    render(<SiaranPage />);

    expect(screen.getByText("Belum ada siaran langsung.")).toBeTruthy();
  });

  it("never shows a loading indicator — there is nothing to load yet", () => {
    render(<SiaranPage />);

    expect(screen.queryAllByText("Memuat...").length).toBe(0);
  });
});
