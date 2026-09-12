import { useState, useSyncExternalStore } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { isUserSignedIn, subscribeToUserAuth } from "./apiClient";
import Sidebar from "./shell/Sidebar";
import ChatPanel from "./ChatPanel";

/**
 * The three destinations that never change — see
 * `docs/superpowers/specs/2026-08-17-member-ui-design.md` §3. The fourth
 * ("Profil" vs "Masuk") depends on whether a session exists, so it is not a
 * static entry here — see `useDestinations` below, which is the ONE place
 * the full four-item list is produced. `AppShell` renders that result TWICE
 * (a bottom bar below `md`, a side rail at `md` and above; CSS at
 * `styles.css`'s `@media (min-width: 768px)` decides which is visible)
 * rather than maintaining two lists — this project has already paid for the
 * same rule living in two places (a limit constant whose tested copy was
 * the one nothing used).
 */
const STATIC_DESTINATIONS = [
  { to: "/beranda", label: "Beranda" },
  { to: "/discover", label: "Discover" },
  { to: "/siaran", label: "Siaran" },
] as const;

/**
 * The fourth destination, computed ONCE per render and handed to both nav
 * shapes below — not two independently-decided links.
 *
 * Review finding: pointing this at `/pengaturan` unconditionally was wrong
 * for a signed-out visitor, who would tap "Profil" and land bounced straight
 * back out to `/masuk` by `SettingsPage`'s own guard. The fix is NOT a
 * fetch — the shell still cannot know a signed-out visitor's handle, and
 * that reasoning for not linking straight to `/@handle` stands — but knowing
 * whether a session exists AT ALL needs no network call, only the same
 * synchronous token check `SettingsPage.tsx` already makes.
 * Signed in, this reads "Profil" -> `/pengaturan`, same as before. Signed
 * out, it reads "Masuk" -> `/masuk`, so the nav does not lie about what
 * tapping it will do. Beranda/Discover/Siaran stay public routes either way
 * — discovery-first means a signed-out visitor can still browse them — only
 * this one label and target change.
 *
 * Asks `isUserSignedIn` rather than comparing the raw token itself (final
 * review I2): that function is the ONE place "is there a session?" is answered,
 * and it answers from the token key alone. It also returns a boolean, which is
 * a stable `useSyncExternalStore` snapshot for free.
 */
function useDestinations(): ReadonlyArray<{ to: string; label: string }> {
  const signedIn = useSyncExternalStore(subscribeToUserAuth, isUserSignedIn, () => false);
  const profile = signedIn ? { to: "/pengaturan", label: "Profil" } : { to: "/masuk", label: "Masuk" };
  return [...STATIC_DESTINATIONS, profile];
}

function activeClass({ isActive }: { isActive: boolean }): string | undefined {
  return isActive ? "active" : undefined;
}

function Destinations({ destinations }: { destinations: ReturnType<typeof useDestinations> }) {
  return (
    <>
      {destinations.map((destination) => (
        <NavLink key={destination.to} to={destination.to} className={activeClass}>
          {destination.label}
        </NavLink>
      ))}
    </>
  );
}

/**
 * The chrome every member-facing page sits inside — see the design spec's
 * §3. Mounted as a path-less layout route in `App.tsx` wrapping `/beranda`,
 * `/discover`, `/siaran`, `/pengaturan`, and — since 2026-08-25 — the public
 * profile `/:handleParam` and its two follow lists.
 *
 * What stays OUTSIDE, and never renders this nav: `/signup`, `/masuk`,
 * `/lupa-sandi`, `/reset/:token` (a nav on an auth page is noise, and its
 * fourth item would point at the page you are already on), plus `/` and the
 * catch-all 404, which carry their own layouts.
 *
 * Every child route stays reachable signed out — this shell does not gate
 * them itself, only `/pengaturan`'s own `SettingsPage` guard does. That is
 * precisely why the profile could move in: `useDestinations` below reads
 * "Masuk" rather than "Profil" with no session, so the nav on a public page
 * cannot offer a door that is not there.
 */
export default function AppShell() {
  const destinations = useDestinations();
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="app-shell">
      <Sidebar
        destinations={destinations}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((value) => !value)}
      />
      {/*
        A <div>, NOT a <main>: every page this shell renders brings its own
        <main className="user-page">, so a <main> here would nest one inside
        the other — invalid HTML, and two "main" landmarks for assistive
        technology to choose between.
      */}
      <div className="app-shell-main">
        <Outlet />
      </div>
      {/* Phase 8b. Floating, outside the scrolling page so it survives
          navigation — and it renders nothing at all when signed out, which
          also means no authenticated endpoint is polled by a visitor. */}
      <ChatPanel />
      <nav className="bottom-nav" aria-label="Navigasi utama">
        <Destinations destinations={destinations} />
      </nav>
    </div>
  );
}
