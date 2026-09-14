import { Fragment, useState, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChartLine,
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

/** Where the "Komunitas" and "Dashboard Creator" submenus are inserted — right after this destination. */
const KOMUNITAS_AFTER = "/discover";

function communityHref(slug: string): string {
  return `/komunitas/${encodeURIComponent(slug)}`;
}

function dashboardHref(slug: string): string {
  return `/komunitas/${encodeURIComponent(slug)}/dashboard`;
}

/**
 * The expand/collapse submenu shape shared by "Komunitas" (every community
 * the viewer has joined) and "Dashboard Creator" (`DashboardCreatorGroup`
 * below — the ones the viewer owns, referenced by `CreatorDashboardPage`'s
 * own docstring). Extracted once the second submenu needed the exact same
 * toggle/list/empty-note behavior as the first — see this session's own
 * scoped design ("just expand/collapse", "show an empty note").
 *
 * Auto-expanded on first render when `autoExpand` says the viewer is already
 * on a relevant page, so the active submenu item is visible without an extra
 * click; after that its open/closed state is local and does not track
 * further navigation.
 *
 * Collapsed rail: renders only the icon, like every other item, and never
 * its submenu — there is no room for one, and toggling it open would show
 * nothing anyway.
 */
function SidebarGroup({
  title,
  icon,
  items,
  hrefFor,
  autoExpand,
  emptyNote,
  collapsed,
}: {
  title: string;
  icon: IconDefinition;
  items: ReadonlyArray<{ slug: string; name: string }>;
  hrefFor: (slug: string) => string;
  autoExpand: (pathname: string) => boolean;
  emptyNote: ReactNode;
  collapsed: boolean;
}) {
  const location = useLocation();
  const [open, setOpen] = useState(() => autoExpand(location.pathname));

  return (
    <div className="side-rail-group">
      <button
        type="button"
        className="sidebar-nav side-rail-group-toggle"
        title={collapsed ? title : undefined}
        aria-expanded={!collapsed && open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sidebar-nav-icon">
          <FontAwesomeIcon icon={icon} />
        </span>
        <span className={collapsed ? "visually-hidden" : undefined}>{title}</span>
        {collapsed ? null : (
          <FontAwesomeIcon
            icon={open ? faChevronUp : faChevronDown}
            className="side-rail-group-chevron"
          />
        )}
      </button>
      {collapsed || !open ? null : (
        <div className="side-rail-submenu">
          {items.length === 0 ? (
            <p className="side-rail-submenu-empty muted">{emptyNote}</p>
          ) : (
            items.map((item) => (
              <NavLink
                key={item.slug}
                to={hrefFor(item.slug)}
                className={({ isActive }) =>
                  isActive ? "sidebar-subnav sidebar-subnav-active" : "sidebar-subnav"
                }
              >
                {item.name}
              </NavLink>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function KomunitasGroup({
  communities,
  collapsed,
}: {
  communities: ReadonlyArray<{ slug: string; name: string }>;
  collapsed: boolean;
}) {
  return (
    <SidebarGroup
      title="Komunitas"
      icon={faUsers}
      items={communities}
      hrefFor={communityHref}
      autoExpand={(pathname) => pathname.startsWith("/komunitas/")}
      emptyNote={
        <>
          Belum ada komunitas. <Link to="/discover">Jelajahi Discover</Link>
        </>
      }
      collapsed={collapsed}
    />
  );
}

/**
 * The "Dashboard Creator" submenu: every community the viewer OWNS, each
 * linking to `CreatorDashboardPage`'s route. `KomunitasGroup`'s sibling —
 * same toggle/list/empty-note shape via `SidebarGroup`, filtered to
 * ownership rather than membership.
 */
function DashboardCreatorGroup({
  communities,
  collapsed,
}: {
  communities: ReadonlyArray<{ slug: string; name: string }>;
  collapsed: boolean;
}) {
  return (
    <SidebarGroup
      title="Dashboard Creator"
      icon={faChartLine}
      items={communities}
      hrefFor={dashboardHref}
      autoExpand={(pathname) => pathname.endsWith("/dashboard")}
      emptyNote={
        <>
          Anda belum memiliki komunitas. <Link to="/komunitas/baru">Buat komunitas</Link>
        </>
      }
      collapsed={collapsed}
    />
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
  /** `null` = don't render "Komunitas"/"Dashboard Creator" at all — see `useMyCommunities` in `AppShell.tsx`. */
  myCommunities: ReadonlyArray<{ slug: string; name: string; isOwner: boolean }> | null;
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
            <>
              <KomunitasGroup communities={myCommunities} collapsed={collapsed} />
              <DashboardCreatorGroup
                communities={myCommunities.filter((community) => community.isOwner)}
                collapsed={collapsed}
              />
            </>
          ) : null}
        </Fragment>
      ))}
    </nav>
  );
}
