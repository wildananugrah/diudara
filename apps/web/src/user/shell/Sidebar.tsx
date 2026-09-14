import { Fragment, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faChevronUp,
  faCompass,
  faHouse,
  faTowerBroadcast,
  faUser,
  faUsers,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { Link, NavLink, useLocation } from "react-router-dom";

/**
 * The reference's rail: 248px, inset on all sides rather than flush
 * (`margin: 10px`, `border-radius: 20px`), sticky, collapsing to 76px.
 *
 * The parent/submenu machinery the reference has was NOT built for Phase 0's
 * four flat destinations — this is that machinery, added for exactly the
 * consumer this module's own docstring once named: the joined-communities
 * list, below. It is SIDEBAR-ONLY; the mobile bottom bar (`AppShell.tsx`'s
 * own `Destinations`) stays the flat list it always was — a submenu does not
 * fit that layout, and a visitor on mobile still reaches their communities
 * through Discover.
 */
const ICONS: Record<string, IconDefinition> = {
  "/beranda": faHouse,
  "/discover": faCompass,
  "/siaran": faTowerBroadcast,
  "/pengaturan": faUser,
  "/masuk": faUser,
};

/** Where the "Komunitas" submenu is inserted — right after this destination. */
const KOMUNITAS_AFTER = "/discover";

function communityHref(slug: string): string {
  return `/komunitas/${encodeURIComponent(slug)}`;
}

/**
 * The "Komunitas" submenu: every community the viewer has joined, expandable
 * under its own toggle rather than a link — see this session's own scoped
 * design ("just expand/collapse", "show an empty note").
 *
 * Auto-expanded on first render when the viewer is already on a community's
 * page, so the active submenu item is visible without an extra click; after
 * that its open/closed state is local and does not track further navigation.
 *
 * Collapsed rail: renders only the icon, like every other item, and never
 * its submenu — there is no room for one, and toggling it open would show
 * nothing anyway.
 */
function KomunitasGroup({
  communities,
  collapsed,
}: {
  communities: ReadonlyArray<{ slug: string; name: string }>;
  collapsed: boolean;
}) {
  const location = useLocation();
  const [open, setOpen] = useState(() => location.pathname.startsWith("/komunitas/"));

  return (
    <div className="side-rail-group">
      <button
        type="button"
        className="sidebar-nav side-rail-group-toggle"
        title={collapsed ? "Komunitas" : undefined}
        aria-expanded={!collapsed && open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sidebar-nav-icon">
          <FontAwesomeIcon icon={faUsers} />
        </span>
        <span className={collapsed ? "visually-hidden" : undefined}>Komunitas</span>
        {collapsed ? null : (
          <FontAwesomeIcon
            icon={open ? faChevronUp : faChevronDown}
            className="side-rail-group-chevron"
          />
        )}
      </button>
      {collapsed || !open ? null : (
        <div className="side-rail-submenu">
          {communities.length === 0 ? (
            <p className="side-rail-submenu-empty muted">
              Belum ada komunitas. <Link to="/discover">Jelajahi Discover</Link>
            </p>
          ) : (
            communities.map((community) => (
              <NavLink
                key={community.slug}
                to={communityHref(community.slug)}
                className={({ isActive }) =>
                  isActive ? "sidebar-subnav sidebar-subnav-active" : "sidebar-subnav"
                }
              >
                {community.name}
              </NavLink>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({
  destinations,
  collapsed,
  onToggleCollapse,
  myCommunities,
}: {
  destinations: ReadonlyArray<{ to: string; label: string }>;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** `null` = don't render "Komunitas" at all — see `useMyCommunities` in `AppShell.tsx`. */
  myCommunities: ReadonlyArray<{ slug: string; name: string }> | null;
}) {
  return (
    <nav
      className={collapsed ? "side-rail side-rail-collapsed" : "side-rail"}
      aria-label="Navigasi utama"
    >
      <div className="side-rail-brand">
        {!collapsed && <span className="side-rail-wordmark">DIUDARA</span>}
        <button
          type="button"
          className="btn btn-ghost btn-icon side-rail-toggle"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Buka navigasi" : "Tutup navigasi"}
        >
          <FontAwesomeIcon icon={collapsed ? faChevronRight : faChevronLeft} />
        </button>
      </div>
      {destinations.map((destination) => (
        <Fragment key={destination.to}>
          <NavLink
            to={destination.to}
            title={collapsed ? destination.label : undefined}
            className={({ isActive }) =>
              isActive ? "sidebar-nav sidebar-nav-active" : "sidebar-nav"
            }
          >
            <span className="sidebar-nav-icon">
              <FontAwesomeIcon icon={ICONS[destination.to] ?? faCompass} />
            </span>
            <span className={collapsed ? "visually-hidden" : undefined}>{destination.label}</span>
          </NavLink>
          {destination.to === KOMUNITAS_AFTER && myCommunities !== null ? (
            <KomunitasGroup communities={myCommunities} collapsed={collapsed} />
          ) : null}
        </Fragment>
      ))}
    </nav>
  );
}
