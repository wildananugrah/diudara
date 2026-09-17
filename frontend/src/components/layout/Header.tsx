import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faRightFromBracket, faUserPen } from "@fortawesome/free-solid-svg-icons";
import { useAuth } from "../../lib/auth";
import Avatar from "../ui/Avatar";
import NotificationBell from "./NotificationBell";

type Crumb = { label: string; to?: string };

type Props = {
  title: string;
  subtitle?: string;
  /** Trail rendered below the title, e.g. Komunitas / Bimbel Matematika Pak Andi */
  breadcrumb?: Crumb[];
  /** Page-specific controls (search, filter, tabs, dsb.) rendered before notifikasi/avatar */
  actions?: ReactNode;
  /** false untuk halaman tanpa sidebar — divider jadi full-bleed sampai ujung */
  insetDivider?: boolean;
};

export default function Header({ title, subtitle, breadcrumb, actions, insetDivider = true }: Props) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click-outside closes the menu; without it the panel would stay open while
  // the user interacts with the page behind it.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const handleLogout = () => {
    setMenuOpen(false);
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <header
      style={{
        flexShrink: 0,
        background: "var(--header-bg)",
        padding: 20,
        paddingTop: 20,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 20,
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      {/* Divider inset to match the header's own left/right padding (full-bleed when there's no sidebar) */}
      <div style={{ position: "absolute", left: insetDivider ? 20 : 0, right: insetDivider ? 20 : 0, bottom: 0, height: 1, background: "var(--border)" }} />
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>{title}</h1>
        {subtitle && (
          <p style={{ fontSize: 12.5, color: "var(--ink-500)", marginTop: 2 }}>{subtitle}</p>
        )}
        {breadcrumb && breadcrumb.length > 0 && (
          <p style={{ fontSize: 12.5, color: "var(--ink-500)", marginTop: 2 }}>
            {breadcrumb.map((c, i) => (
              <span key={i}>
                {c.to ? (
                  <Link to={c.to} style={{ color: "var(--ink-500)" }}>{c.label}</Link>
                ) : (
                  c.label
                )}
                {i < breadcrumb.length - 1 && <span style={{ margin: "0 6px" }}>/</span>}
              </span>
            ))}
          </p>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16, flexShrink: 0 }}>
        {actions}

        <NotificationBell />

        <div ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
          <div
            onClick={() => setMenuOpen((o) => !o)}
            style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}
          >
            <Avatar initials={user?.initials ?? "?"} color={user?.avatarColor} size={36} />
            <div style={{ lineHeight: 1.3 }}>
              <p style={{ fontSize: 13, fontWeight: 600 }}>{user?.name ?? "Memuat…"}</p>
              <p style={{ fontSize: 11.5, color: "var(--ink-500)" }}>{user?.handle ?? ""}</p>
            </div>
          </div>

          {menuOpen && (
            <div
              className="card"
              style={{
                position: "absolute", top: "calc(100% + 8px)", right: 0, minWidth: 190,
                padding: 6, boxShadow: "var(--shadow-card)", zIndex: 20,
              }}
            >
              <button
                onClick={() => { setMenuOpen(false); navigate("/profile"); }}
                className="hover-bg"
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 9,
                  padding: "9px 12px", borderRadius: 10, border: "none", background: "transparent",
                  color: "var(--ink-700)", fontSize: 13.5, fontWeight: 600, textAlign: "left",
                }}
              >
                <FontAwesomeIcon icon={faUserPen} /> Profil saya
              </button>
              <button
                onClick={handleLogout}
                className="hover-bg"
                style={{
                  width: "100%", display: "flex", alignItems: "center", gap: 9,
                  padding: "9px 12px", borderRadius: 10, border: "none", background: "transparent",
                  color: "var(--merah-senja)", fontSize: 13.5, fontWeight: 600, textAlign: "left",
                }}
              >
                <FontAwesomeIcon icon={faRightFromBracket} /> Keluar
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
