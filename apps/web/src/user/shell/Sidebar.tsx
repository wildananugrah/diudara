import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronLeft, faChevronRight, faCompass, faHouse, faTowerBroadcast, faUser } from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { NavLink } from "react-router-dom";

/**
 * The reference's rail: 248px, inset on all sides rather than flush
 * (`margin: 10px`, `border-radius: 20px`), sticky, collapsing to 76px.
 *
 * The parent/submenu machinery the reference has is NOT built here. Phase 0
 * has four flat destinations and no groups; building the group state now
 * would be scaffolding for a consumer that does not exist yet. Phase 1 adds
 * it along with the joined-communities and created-communities lists that
 * need it.
 */
const ICONS: Record<string, IconDefinition> = {
  "/beranda": faHouse,
  "/jelajah": faCompass,
  "/siaran": faTowerBroadcast,
  "/pengaturan": faUser,
  "/masuk": faUser,
};

export default function Sidebar({
  destinations,
  collapsed,
  onToggleCollapse,
}: {
  destinations: ReadonlyArray<{ to: string; label: string }>;
  collapsed: boolean;
  onToggleCollapse: () => void;
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
        <NavLink
          key={destination.to}
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
      ))}
    </nav>
  );
}
