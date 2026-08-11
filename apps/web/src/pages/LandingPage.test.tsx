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

  // Tests the RULE, not two spellings: no sentence that mentions WhatsApp may
  // also talk about access, joining, or invites. A prior version of this test
  // only forbade the two literal phrases "grup whatsapp otomatis" and "akses
  // grup whatsapp" — it missed "akses anggota ... untuk grup Telegram dan
  // WhatsApp", which reads as WhatsApp access being automated when it is not:
  // Meta's API has no add-participant endpoint and caps groups at 8 members.
  // Sentences are read per <p>/<li> (not the whole page as one blob) so two
  // unrelated sentences in different elements are never spuriously merged.
  it("never puts access, joining, or invite language in the same sentence as WhatsApp", () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    );
    const blocks = Array.from(document.querySelectorAll("p, li"));
    const sentences = blocks.flatMap((block) => (block.textContent ?? "").split(/(?<=[.!?])\s+/));
    const mentionsWhatsapp = sentences.filter((s) => /whatsapp/i.test(s));
    // WhatsApp must still appear somewhere — the page cannot pass by omitting it.
    expect(mentionsWhatsapp.length).toBeGreaterThan(0);
    const gatedSounding = mentionsWhatsapp.filter((s) => /akses|gabung|undangan/i.test(s));
    expect(gatedSounding.length).toBe(0);
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
