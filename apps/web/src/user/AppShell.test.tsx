import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { setUserSession } from "./apiClient";
import AppShell from "./AppShell";

/**
 * `AppShell` produces its four destinations from ONE place
 * (`useDestinations` in AppShell.tsx) and renders that result TWICE — once
 * as a bottom bar, once as a side rail — letting CSS
 * (`@media (min-width: 768px)`) decide which is visible. jsdom/happy-dom
 * does not evaluate that media query, so BOTH are present in every render
 * here; that is exactly what lets these tests prove "one source, two
 * shapes" instead of two separately maintained lists — see the task
 * brief's own warning about that drift.
 */

const USER = { id: "user-1", handle: "wildan", displayName: "Wildan", email: "wildan@example.com" };

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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => cleanup());

describe("AppShell", () => {
  it("renders the three fixed destinations twice each — one source, a bottom bar and a side rail", () => {
    renderShellAt("/beranda");

    for (const label of ["Beranda", "Jelajah", "Siaran"]) {
      expect(screen.getAllByRole("link", { name: label }).length).toBe(2);
    }
  });

  it("signed in: shows Profil -> /pengaturan, twice", () => {
    setUserSession("jwt-abc", USER);
    renderShellAt("/beranda");

    const profilLinks = screen.getAllByRole("link", { name: "Profil" });
    expect(profilLinks.length).toBe(2);
    for (const link of profilLinks) {
      expect(link.getAttribute("href")).toBe("/pengaturan");
    }
    expect(screen.queryAllByRole("link", { name: "Masuk" }).length).toBe(0);
  });

  /**
   * IMPORTANT 2 from Task 4's review: pointing the fourth item at
   * `/pengaturan` unconditionally meant a signed-out visitor tapped "Profil"
   * and was bounced straight back out by SettingsPage's own guard. The nav
   * must tell the truth about what it will do — see useDestinations' own
   * docstring for the full reasoning.
   */
  it("signed out: shows Masuk -> /masuk instead of Profil, twice", () => {
    renderShellAt("/beranda");

    const masukLinks = screen.getAllByRole("link", { name: "Masuk" });
    expect(masukLinks.length).toBe(2);
    for (const link of masukLinks) {
      expect(link.getAttribute("href")).toBe("/masuk");
    }
    expect(screen.queryAllByRole("link", { name: "Profil" }).length).toBe(0);
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
