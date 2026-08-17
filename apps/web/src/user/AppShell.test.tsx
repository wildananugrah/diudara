import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import AppShell from "./AppShell";

/**
 * `AppShell` renders the SAME `DESTINATIONS` array twice — once as a bottom
 * bar, once as a side rail — and lets CSS (`@media (min-width: 768px)`)
 * decide which is visible. jsdom/happy-dom does not evaluate that media
 * query, so BOTH are present in every render here; that is exactly what lets
 * these tests prove "one source, two shapes" instead of two separately
 * maintained lists — see the task brief's own warning about that drift.
 */

function Dummy({ label }: { label: string }) {
  return <p>{label} page content</p>;
}

function renderShellAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/beranda" element={<Dummy label="Beranda" />} />
          <Route path="/jelajah" element={<Dummy label="Jelajah" />} />
          <Route path="/siaran" element={<Dummy label="Siaran" />} />
          <Route path="/pengaturan" element={<Dummy label="Pengaturan" />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => cleanup());

describe("AppShell", () => {
  it("renders all four destinations twice — one array, a bottom bar and a side rail", () => {
    renderShellAt("/beranda");

    for (const label of ["Beranda", "Jelajah", "Siaran", "Profil"]) {
      expect(screen.getAllByRole("link", { name: label }).length).toBe(2);
    }
  });

  it("points every Profil link at /pengaturan, never a handle URL", () => {
    renderShellAt("/beranda");

    const profilLinks = screen.getAllByRole("link", { name: "Profil" });
    expect(profilLinks.length).toBe(2);
    for (const link of profilLinks) {
      expect(link.getAttribute("href")).toBe("/pengaturan");
    }
  });

  it("navigates to the tapped destination and renders its page inside the shell", () => {
    renderShellAt("/beranda");
    expect(screen.getByText("Beranda page content")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("link", { name: "Siaran" })[0]);

    expect(screen.getByText("Siaran page content")).toBeTruthy();
    expect(screen.queryAllByText("Beranda page content").length).toBe(0);
  });

  it("renders on /beranda, /jelajah and /siaran", () => {
    for (const path of ["/beranda", "/jelajah", "/siaran"]) {
      renderShellAt(path);
      expect(screen.getAllByRole("navigation").length).toBeGreaterThan(0);
      cleanup();
    }
  });
});
