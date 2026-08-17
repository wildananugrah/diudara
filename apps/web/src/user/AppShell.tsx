import { useSyncExternalStore } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { getUserToken, subscribeToUserAuth } from "./apiClient";

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
  { to: "/jelajah", label: "Jelajah" },
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
 * synchronous token check `SettingsPage.tsx` already makes:
 * `useSyncExternalStore(subscribeToUserAuth, getUserToken, () => null)`.
 * Signed in, this reads "Profil" -> `/pengaturan`, same as before. Signed
 * out, it reads "Masuk" -> `/masuk`, so the nav does not lie about what
 * tapping it will do. Beranda/Jelajah/Siaran stay public routes either way
 * — discovery-first means a signed-out visitor can still browse them — only
 * this one label and target change.
 */
function useDestinations(): ReadonlyArray<{ to: string; label: string }> {
  const token = useSyncExternalStore(subscribeToUserAuth, getUserToken, () => null);
  const profile = token !== null ? { to: "/pengaturan", label: "Profil" } : { to: "/masuk", label: "Masuk" };
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
 * §3. Mounted as a path-less layout route wrapping `/beranda`, `/jelajah`,
 * `/siaran` and `/pengaturan` in `App.tsx`; `/signup`, `/masuk`,
 * `/lupa-sandi`, `/reset/:token` and `/:handleParam` (the public profile)
 * are registered OUTSIDE it and never render this nav at all. Those four
 * child routes stay reachable signed out too — this shell does not gate
 * them itself, only `/pengaturan`'s own `SettingsPage` guard does.
 */
export default function AppShell() {
  const destinations = useDestinations();
  return (
    <div className="app-shell">
      <nav className="side-rail" aria-label="Navigasi utama">
        <Destinations destinations={destinations} />
      </nav>
      <main className="app-shell-main">
        <Outlet />
      </main>
      <nav className="bottom-nav" aria-label="Navigasi utama">
        <Destinations destinations={destinations} />
      </nav>
    </div>
  );
}
