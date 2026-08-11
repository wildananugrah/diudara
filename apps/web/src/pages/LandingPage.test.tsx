import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LandingPage from "./LandingPage";
import { AppRoutes } from "../App";

afterEach(cleanup);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );
}

describe("LandingPage", () => {
  it("renders its headline", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    expect(screen.getAllByRole("heading", { level: 1 }).length).toBe(1);
  });

  it("points every call to action at the dashboard login", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const ctas = screen.getAllByRole("link", { name: /mulai/i });
    expect(ctas.length).toBeGreaterThan(0);
    for (const cta of ctas) {
      expect(cta.getAttribute("href")).toBe("/dashboard/login");
    }
  });

  // THE REGRESSION THIS CHANGE EXISTS TO PREVENT. Before it, "/" matched no
  // route, fell through the catch-all, and redirected to /c/tidak-ada — the
  // bare domain told every visitor a specific community was missing when none
  // had been named.
  it("serves / from the landing page and does not redirect", () => {
    renderAt("/");
    expect(screen.getAllByRole("heading", { level: 1 }).length).toBe(1);
    expect(document.body.textContent).not.toContain("tidak ditemukan");
  });

  it("never says WhatsApp groups are gated — WhatsApp is notification-only", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const text = document.body.textContent ?? "";
    expect(/whatsapp/i.test(text)).toBe(true);
    // The forbidden claim, in the shapes it would plausibly take.
    expect(/grup whatsapp otomatis/i.test(text)).toBe(false);
    expect(/akses grup whatsapp/i.test(text)).toBe(false);
  });

  // The page renders only static copy, so this is true by construction today.
  // The assertion exists so it stays true if anyone later renders anything
  // dynamic here — the spec forbids dangerouslySetInnerHTML on this page.
  it("uses no dangerouslySetInnerHTML", async () => {
    const source = await Bun.file(
      new URL("./LandingPage.tsx", import.meta.url).pathname
    ).text();
    expect(source.includes("dangerouslySetInnerHTML")).toBe(false);
  });

  it("quotes no price, because the platform fee has never been decided", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const text = document.body.textContent ?? "";
    expect(/rp\s?\d/i.test(text)).toBe(false);
    expect(/\d+\s?%/.test(text)).toBe(false);
  });
});
