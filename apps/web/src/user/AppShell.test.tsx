import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { setUserSession } from "./apiClient";
import AppShell from "./AppShell";
import { rules, selectors, stylesheet } from "../test/stylesheet";

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

  /**
   * Final-review I2, the single-key half, pinned where a user can see it.
   *
   * "Is there a session?" used to be answered from two different storage keys —
   * the token in `getProfileByHandle`/`SettingsPage`/here, the ACCOUNT cache in
   * `FollowRow`. Every existing test either clears storage or goes through
   * `setUserSession`, which writes both keys, so nothing ever put them out of
   * step and nothing noticed the disagreement. This test does put them out of
   * step: a valid token, no cached account. The nav must read "Profil", because
   * the session is real — the account cache answers "who am I?", not "am I
   * signed in?".
   */
  it("token held but no cached account: still shows Profil, because the session is real", () => {
    setUserSession("jwt-abc", USER);
    localStorage.removeItem("diudara.user.account");

    renderShellAt("/beranda");

    expect(screen.getAllByRole("link", { name: "Profil" }).length).toBe(2);
    expect(screen.queryAllByRole("link", { name: "Masuk" }).length).toBe(0);
  });

  it("cached account but no token: shows Masuk, because the session is gone", () => {
    setUserSession("jwt-abc", USER);
    localStorage.removeItem("diudara.user.token");

    renderShellAt("/beranda");

    // Asserted the opposite way round from the test above on purpose: a reader
    // switched to the account key would pass one of the pair and fail the
    // other, never both.
    expect(screen.getAllByRole("link", { name: "Masuk" }).length).toBe(2);
    expect(screen.queryAllByRole("link", { name: "Profil" }).length).toBe(0);
  });
});

describe("AppShell — the Udara shell", () => {
  it("still renders one destination list twice, as a rail and a bar", () => {
    renderShellAt("/beranda");
    for (const label of ["Beranda", "Jelajah", "Siaran"]) {
      expect(screen.getAllByRole("link", { name: label }).length).toBe(2);
    }
  });

  it("collapses and expands the rail, and says which state it is in", () => {
    renderShellAt("/beranda");

    const toggle = screen.getByRole("button", { name: "Tutup navigasi" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle);

    const reopened = screen.getByRole("button", { name: "Buka navigasi" });
    expect(reopened.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the rail's links reachable while collapsed, so it is a narrow rail and not a hidden one", () => {
    renderShellAt("/beranda");
    fireEvent.click(screen.getByRole("button", { name: "Tutup navigasi" }));

    // Still two of each: the bar is untouched by the rail's collapse.
    expect(screen.getAllByRole("link", { name: "Beranda" }).length).toBe(2);
  });
});
/**
 * Every `z-index` the sheet declares, split into the navigation's and
 * everything else's. A rule with no `z-index` contributes nothing.
 */
function zIndexes(): { nav: { selector: string; value: number }[]; other: { selector: string; value: number }[] } {
  const nav: { selector: string; value: number }[] = [];
  const other: { selector: string; value: number }[] = [];
  for (const rule of rules(stylesheet())) {
    const match = /(?:^|;)\s*z-index:\s*(-?\d+)/.exec(rule.body);
    if (match === null) continue;
    const entry = { selector: rule.selector, value: Number(match[1]) };
    const isNav = rule.selector.includes(".bottom-nav") || rule.selector.includes(".side-rail");
    (isNav ? nav : other).push(entry);
  }
  return { nav, other };
}

/**
 * The navigation is chrome: it must paint above page content, always.
 *
 * Both shapes are `position: fixed`, and both used to declare no `z-index` at
 * all — which leaves them at `z-index: auto` in the ROOT stacking context,
 * level with (and therefore merely source-ordered against) every positioned
 * element on the page. `.badge-members` is `position: absolute; z-index: 1`
 * inside `.stream-card` / `.stream-lock`, which are `position: relative` with
 * `z-index: auto` and so create NO stacking context to contain it. On Siaran
 * those badges painted straight over the bottom bar.
 *
 * Asserted as an INVARIANT, not a literal value: whatever the navigation
 * declares must beat every other `z-index` in the sheet. A future
 * `z-index: 99` somewhere else fails here instead of quietly covering the
 * only way to leave the page.
 *
 * WHAT THIS CANNOT DO — see `../test/stylesheet.ts`: it reads rule text, so it
 * cannot weigh specificity, see `!important`, know a rule's `@media` context,
 * or account for inline styles. It catches a missing declaration and a rival
 * one, which is the failure that actually happened here.
 */
describe("AppShell — the navigation paints above the page", () => {
  it("declares a z-index on both nav shapes", () => {
    const declaring = zIndexes().nav;

    // Named, not counted: a failure should say WHICH shape lost its z-index.
    expect(selectors(declaring)).toContain(".bottom-nav");
    expect(selectors(declaring)).toContain(".side-rail");
  });

  it("gives the navigation a higher z-index than anything else in the sheet", () => {
    const { nav, other } = zIndexes();
    // Not decoration: with `nav` empty, `Math.min()` is Infinity and every
    // assertion below passes vacuously. This test would then go green on
    // exactly the bug the test above exists to catch.
    expect(nav.length).toBeGreaterThanOrEqual(2);
    const lowestNav = Math.min(...nav.map((rule) => rule.value));
    const highestOther = other.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...other.map((rule) => rule.value));

    // Reported as strings so a failure prints the offending selector and both
    // numbers, rather than a bare `false`.
    const offenders = other.filter((rule) => rule.value >= lowestNav);
    expect(selectors(offenders)).toBe("");
    expect(lowestNav > highestOther).toBe(true);
  });
});
