import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import NotFoundPage from "../pages/NotFoundPage";
import { UserApiError, getCommunity, type CommunityDetail } from "./apiClient";
import StatistikTab from "./StatistikTab";
import { describeRequestFailure } from "./errorCopy";
import Header from "./shell/Header";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; community: CommunityDetail };

/**
 * `/komunitas/:slug/dashboard` — "Dashboard Creator" in the design
 * reference, reached from the sidebar's own submenu of the same name (see
 * `Sidebar.tsx`'s `DashboardCreatorGroup`).
 *
 * A page of its own rather than a query param on `CommunityPage` — this
 * session's own scoped design: no banner, no tab bar, just the owner's
 * numbers, matching the reference's dedicated layout.
 *
 * **Reuses `StatistikTab` unchanged** — the exact same tested,
 * real-data-backed component `CommunityPage`'s own Statistik tab renders —
 * rather than a second implementation of the same fetch and the same four
 * panels.
 *
 * **Gated on `viewerIsOwner` from `getCommunity`, not on
 * `GetCommunityStats`'s own 403.** Checking first means a non-owner who
 * navigates here directly (the URL is guessable regardless of what the
 * sidebar shows) never fires the stats request at all, and reads a message
 * written for this page rather than a generic error string.
 */
export default function CreatorDashboardPage() {
  const { slug } = useParams<{ slug: string }>();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (slug === undefined) return;
    let cancelled = false;
    setLoad({ status: "loading" });
    getCommunity(slug)
      .then((community) => {
        if (!cancelled) setLoad({ status: "ready", community });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UserApiError && err.status === 404) {
          setLoad({ status: "not-found" });
          return;
        }
        setLoad({ status: "error", message: describeRequestFailure(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (load.status === "loading") {
    return (
      <>
        <Header title="Dashboard Creator" />
        <main className="page-container">
          <p>Memuat...</p>
        </main>
      </>
    );
  }

  if (load.status === "not-found") {
    return <NotFoundPage />;
  }

  if (load.status === "error") {
    return (
      <>
        <Header title="Dashboard Creator" />
        <main className="page-container">
          <p className="form-error" role="alert">
            {load.message}
          </p>
        </main>
      </>
    );
  }

  const { community } = load;

  return (
    <>
      <Header
        title="Dashboard Creator"
        subtitle={`Ringkasan performa ${community.name}`}
        breadcrumb={[
          { label: "Komunitas", to: "/discover" },
          { label: community.name, to: `/komunitas/${community.slug}` },
          { label: "Dashboard Creator" },
        ]}
      />
      <main className="page-container creator-dashboard-page">
        {community.viewerIsOwner ? (
          <StatistikTab slug={community.slug} />
        ) : (
          <p className="empty">Hanya pemilik komunitas yang dapat melihat dashboard ini.</p>
        )}
      </main>
    </>
  );
}
