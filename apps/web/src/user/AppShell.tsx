import { NavLink, Outlet } from "react-router-dom";

/**
 * The four destinations, in ONE place — see
 * `docs/superpowers/specs/2026-08-17-member-ui-design.md` §3. `AppShell`
 * renders this array TWICE (a bottom bar below `md`, a side rail at `md` and
 * above; CSS at `styles.css`'s `@media (min-width: 768px)` decides which is
 * visible) rather than maintaining two lists — this project has already
 * paid for the same rule living in two places (a limit constant whose tested
 * copy was the one nothing used).
 *
 * Profil points at `/pengaturan`, NOT `/@handle`: the shell has no fetch of
 * its own, so it cannot know the signed-in visitor's handle to build that
 * href without one. Settings links onward to the visitor's own public
 * profile instead.
 */
const DESTINATIONS = [
  { to: "/beranda", label: "Beranda" },
  { to: "/jelajah", label: "Jelajah" },
  { to: "/siaran", label: "Siaran" },
  { to: "/pengaturan", label: "Profil" },
] as const;

function activeClass({ isActive }: { isActive: boolean }): string | undefined {
  return isActive ? "active" : undefined;
}

function Destinations() {
  return (
    <>
      {DESTINATIONS.map((destination) => (
        <NavLink key={destination.to} to={destination.to} className={activeClass}>
          {destination.label}
        </NavLink>
      ))}
    </>
  );
}

/**
 * The chrome every signed-in, member-facing page sits inside — see the
 * design spec's §3. Mounted as a path-less layout route wrapping `/beranda`,
 * `/jelajah`, `/siaran` and `/pengaturan` in `App.tsx`; `/signup`, `/masuk`,
 * `/lupa-sandi`, `/reset/:token` and `/:handleParam` (the public profile)
 * are registered OUTSIDE it and never render this nav at all.
 */
export default function AppShell() {
  return (
    <div className="app-shell">
      <nav className="side-rail" aria-label="Navigasi utama">
        <Destinations />
      </nav>
      <main className="app-shell-main">
        <Outlet />
      </main>
      <nav className="bottom-nav" aria-label="Navigasi utama">
        <Destinations />
      </nav>
    </div>
  );
}
