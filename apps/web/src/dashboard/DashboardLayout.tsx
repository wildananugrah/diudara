import { NavLink, Outlet } from "react-router-dom";
import { clearToken, getCreator } from "./auth";
import { AiCoBuilderNavLink } from "./ui";

/**
 * The chrome every dashboard screen sits inside: brand, top-level navigation, who
 * is signed in, and the way out.
 *
 * The creator's NAME is rendered here and the token never is. The name comes from
 * the cached session (see `auth.ts`) rather than from a request, because there is
 * no `GET /auth/me` endpoint and a header should not need one.
 *
 * "Keluar" only clears the session. It does not navigate: clearing notifies
 * `auth.ts`, the `RequireAuth` wrapping this layout re-renders with no token, and
 * the redirect to login happens there — the same path an expired token takes, so
 * there is one code path for "no longer signed in" rather than two.
 */
export default function DashboardLayout() {
  const creator = getCreator();

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-header-inner">
          <NavLink to="/dashboard" className="brand">
            DIUDARA
          </NavLink>
          <nav className="top-nav" aria-label="Navigasi utama">
            <NavLink to="/dashboard" end>
              Komunitas
            </NavLink>
            <NavLink to="/dashboard/account">Akun &amp; pembayaran</NavLink>
            <AiCoBuilderNavLink />
          </nav>
          <div className="session">
            {creator !== null ? <span className="session-name">{creator.name}</span> : null}
            <button type="button" className="button-quiet" onClick={() => clearToken()}>
              Keluar
            </button>
          </div>
        </div>
      </header>
      <main className="dashboard-main">
        <Outlet />
      </main>
    </div>
  );
}
