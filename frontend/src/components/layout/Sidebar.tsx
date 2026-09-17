import { useCallback, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faCompass,
  faUserGroup,
  faChartLine,
  faFingerprint,
  faChevronLeft,
  faChevronDown,
} from "@fortawesome/free-solid-svg-icons";
import { api } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import logoDark from "../../assets/logo-dark.svg";
import iconDark from "../../assets/icon-dark.svg";

type NavChild = { to: string; label: string };
type NavItem = {
  key: string;
  label: string;
  icon: IconDefinition;
  to?: string;
  children?: NavChild[];
};

const EXPANDED_WIDTH = "var(--sidebar-width)";
const COLLAPSED_WIDTH = "76px";

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [openMenus, setOpenMenus] = useState<Record<string, boolean>>({});

  // One request fills both dropdowns. Previously these were module-scope arrays
  // derived from mock data, so they never reflected the signed-in user.
  const { data: mine } = useApi(useCallback(() => api.communities.mine(), []));

  const nav: NavItem[] = [
    { key: "discover", to: "/discover", label: "Discover", icon: faCompass },
    {
      key: "komunitas",
      label: "Komunitas",
      icon: faUserGroup,
      children: (mine?.joined ?? []).map((c) => ({ to: `/community/${c.id}`, label: c.name })),
    },
    {
      key: "creator",
      label: "Dashboard Creator",
      icon: faChartLine,
      children: (mine?.created ?? []).map((c) => ({ to: `/creator/dashboard/${c.id}`, label: c.name })),
    },
    { key: "onboarding", to: "/onboarding", label: "Pulse-ID", icon: faFingerprint },
  ];

  const toggleMenu = (key: string) => setOpenMenus((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <aside
      style={{
        width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
        flexShrink: 0,
        background: "var(--sidebar-bg)",
        border: "1px solid var(--border)",
        borderRadius: 20,
        margin: "10px 0 10px 10px",
        padding: "22px 12px 12px",
        display: "flex",
        flexDirection: "column",
        position: "sticky",
        top: 10,
        height: "calc(100vh - 20px)",
        transition: "width 0.18s ease",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "space-between",
          gap: 8,
          padding: "0 4px 28px",
        }}
      >
        {collapsed ? (
          <img
            src={iconDark}
            alt="Buka sidebar"
            onClick={() => setCollapsed(false)}
            style={{ height: 32, width: "auto", display: "block", cursor: "pointer" }}
          />
        ) : (
          <>
            <img
              src={logoDark}
              alt="Diudara"
              onClick={() => navigate("/discover")}
              style={{ height: 40, width: "auto", display: "block", cursor: "pointer" }}
            />
            <button
              onClick={() => setCollapsed(true)}
              aria-label="Tutup sidebar"
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                border: "none",
                background: "var(--surface)",
                color: "var(--ink-700)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                flexShrink: 0,
              }}
            >
              <FontAwesomeIcon icon={faChevronLeft} />
            </button>
          </>
        )}
      </div>

      <nav style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minHeight: 0, overflowY: "auto" }}>
        {nav.map((item) => {
          if (!item.children) {
            return (
              <NavLink
                key={item.key}
                to={item.to!}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) => `sidebar-nav${isActive ? " sidebar-nav-active" : ""}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: collapsed ? "center" : "flex-start",
                  gap: 10,
                  padding: collapsed ? "9px" : "9px 12px",
                  borderRadius: 999,
                  fontSize: 14,
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, borderRadius: 999, fontSize: 14, flexShrink: 0,
                  }}
                >
                  <FontAwesomeIcon icon={item.icon} />
                </span>
                {!collapsed && item.label}
              </NavLink>
            );
          }

          const isChildActive = item.children.some((c) => location.pathname === c.to);
          const isOpen = collapsed ? false : (openMenus[item.key] ?? isChildActive);

          return (
            <div key={item.key}>
              <button
                onClick={() => (collapsed ? setCollapsed(false) : toggleMenu(item.key))}
                title={collapsed ? item.label : undefined}
                className="sidebar-nav"
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: collapsed ? "center" : "flex-start",
                  gap: 10,
                  padding: collapsed ? "9px" : "9px 12px",
                  borderRadius: 999,
                  fontSize: 14,
                  whiteSpace: "nowrap",
                  border: "none",
                }}
              >
                <span
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, borderRadius: 999, fontSize: 14, flexShrink: 0,
                  }}
                >
                  <FontAwesomeIcon icon={item.icon} />
                </span>
                {!collapsed && <span style={{ flex: 1, textAlign: "left" }}>{item.label}</span>}
                {!collapsed && (
                  <FontAwesomeIcon
                    icon={faChevronDown}
                    style={{
                      fontSize: 11,
                      transition: "transform 0.15s ease",
                      transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
                    }}
                  />
                )}
              </button>

              {!collapsed && isOpen && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2 }}>
                  {item.children.length === 0 && (
                    <p style={{ paddingLeft: 34, fontSize: 12.5, color: "var(--sidebar-text)", opacity: 0.75 }}>
                      {mine ? "Belum ada komunitas" : "Memuat…"}
                    </p>
                  )}
                  {item.children.map((child) => (
                    <div key={child.to + child.label} style={{ paddingLeft: 22, maxWidth: "100%" }}>
                      <NavLink
                        to={child.to}
                        className={({ isActive }) => `sidebar-subnav${isActive ? " sidebar-subnav-active" : ""}`}
                        style={{
                          display: "block",
                          boxSizing: "border-box",
                          width: "100%",
                          padding: "9px 12px",
                          borderRadius: 999,
                          fontSize: 13,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {child.label}
                      </NavLink>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {!collapsed && (
        <div
          className="card"
          style={{
            marginTop: "auto",
            padding: 18,
            background: "var(--langit-dark)",
            border: "none",
            color: "var(--awan)",
            textAlign: "center",
            overflow: "hidden",
            position: "relative",
          }}
        >
          <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 14, position: "relative" }}>
            Upgrade ke Pro Creator untuk buka semua fitur monetisasi.
          </p>
          <button className="btn btn-primary btn-sm btn-block" style={{ position: "relative" }}>
            Upgrade
          </button>
        </div>
      )}
    </aside>
  );
}
