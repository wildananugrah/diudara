import { Link } from "react-router-dom";
import NotificationBell from "../NotificationBell";

export type Crumb = { label: string; to?: string };

/**
 * The sticky page header, ported from the reference.
 *
 * Two deliberate departures from the reference's version:
 *
 * The bell is a LIVE component (Phase 8a), not a prop. It used to be a
 * `notificationCount` number that nothing in this app ever passed — ported
 * from the reference, which hardcodes `notificationCount={3}` on every page
 * and wires no click handler, so its bell permanently claims three
 * notifications that do not exist. `NotificationBell` owns its own polling
 * and renders nothing at all when signed out, so it still cannot lie.
 *
 * The `actions` slot is dead in every reference page but is kept, because
 * Phase 1's CommunityHome puts its invite / share / Posting controls there.
 *
 * The reference's header also carries an identity chip (avatar + name +
 * handle). It is NOT built here: the shell's fourth nav destination already
 * answers "who am I / sign in", and a chip needs a `/me` read this component
 * does not otherwise do. Phase 1 adds it alongside CommunityHome.
 */
export default function Header({
  title,
  subtitle,
  breadcrumb,
  actions,
}: {
  title: string;
  subtitle?: string;
  breadcrumb?: readonly Crumb[];
  actions?: React.ReactNode;
}) {
  return (
    <header className="app-header">
      <div className="app-header-titles">
        <h1>{title}</h1>
        {subtitle !== undefined && <p className="app-header-sub">{subtitle}</p>}
        {breadcrumb !== undefined && breadcrumb.length > 0 && (
          <nav className="app-header-crumbs" aria-label="Remah roti">
            {breadcrumb.map((crumb, index) => (
              <span key={crumb.label}>
                {index > 0 && <span className="app-header-crumb-sep">/</span>}
                {crumb.to === undefined ? crumb.label : <Link to={crumb.to}>{crumb.label}</Link>}
              </span>
            ))}
          </nav>
        )}
      </div>
      <div className="app-header-actions">
        {actions}
        {/* Phase 8a. The bell used to be a `notificationCount` PROP that
            nothing ever passed — ported from the mockup with a hardcoded 3
            and never wired. It is now a live component that owns its own
            polling and renders nothing at all when signed out. */}
        <NotificationBell />
      </div>
    </header>
  );
}
