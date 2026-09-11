import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import NotFoundPage from "../pages/NotFoundPage";
import {
  UserApiError,
  getCommunity,
  getSessionUser,
  listCommunityMembers,
  type CommunityDetail,
  type CommunityMemberRow,
} from "./apiClient";
import { communityColor, communityInk } from "./communityColor";
import CommunityFeed from "./CommunityFeed";
import CommunityJoinControl from "./CommunityJoinControl";
import CommunityTiers from "./CommunityTiers";
import DokumenTab from "./DokumenTab";
import StatistikTab from "./StatistikTab";
import KegiatanTab from "./KegiatanTab";
import { describeRequestFailure } from "./errorCopy";
import Header from "./shell/Header";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; community: CommunityDetail };

function Roster({ members }: { members: CommunityMemberRow[] }) {
  if (members.length === 0) {
    return <p className="empty">Belum ada anggota.</p>;
  }
  return (
    <ul className="card-list follow-list">
      {members.map((member) => (
        <li className="follow-row card" key={member.handle}>
          <Link to={`/@${member.handle}`} className="follow-row-identity">
            <span className="follow-row-name">{member.displayName}</span>
            <span className="follow-row-handle muted">@{member.handle}</span>
          </Link>
          {member.role === "owner" ? <span className="role-badge">Pemilik</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The **Anggota** tab — Phase 1's roster, moved under the tab unchanged (spec
 * §"The web app").
 *
 * A component of its own rather than a branch in the page, so its fetch does
 * not exist at all while Diskusi is showing — "only the active half mounted so
 * opening the roster does not fetch a feed nobody asked for" cuts both ways.
 *
 * The roster fails SILENTLY: a community that loaded is not broken because its
 * member list was unreachable, and an empty roster under a working banner is a
 * smaller lie than an error page over a community that exists.
 */
function AnggotaTab({ slug }: { slug: string }) {
  const [members, setMembers] = useState<CommunityMemberRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    listCommunityMembers(slug)
      .then((result) => {
        if (!cancelled) setMembers(result.members);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <section className="section">
      <h2>Anggota</h2>
      <Roster members={members} />
    </section>
  );
}

/**
 * `/komunitas/:slug` — a community's own page.
 *
 * **The tab bar Phase 1 cut** (spec §"The web app"): **Diskusi** (default) and
 * **Anggota** (Phase 1's roster). Jelajah's pattern exactly — `.feed-tabs`
 * markup, `aria-current`, the tab in the URL as `?tab=` rather than component
 * state so a link to either half works, and only the active half mounted so
 * opening the roster does not fetch a feed nobody asked for.
 *
 * **The join / leave control stays in the banner** (ruling R12) — exactly
 * where Phase 1 put it, so a non-member can join from either tab. `CommunityFeed`
 * renders none of its own; it shows a one-line note where the composer would be.
 *
 * Loading, not-found and error are three separate early returns, the shape
 * `ProfilePage` uses. A 404 renders the shared `NotFoundPage`, with no hint
 * that the slug happens to be free.
 */
export default function CommunityPage() {
  const { slug } = useParams<{ slug: string }>();
  const [params, setParams] = useSearchParams();
  // Phase 3 added `kegiatan`. An unknown `?tab=` still falls back to Diskusi
  // — a link with a typo shows the community rather than nothing.
  const requestedTab = params.get("tab");
  const tab =
    requestedTab === "anggota" ||
    requestedTab === "kegiatan" ||
    requestedTab === "dokumen" ||
    requestedTab === "keanggotaan" ||
    requestedTab === "statistik"
      ? requestedTab
      : "diskusi";
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const signedIn = getSessionUser() !== null;

  useEffect(() => {
    if (slug === undefined) return;
    let cancelled = false;
    setLoad({ status: "loading" });
    getCommunity(slug)
      .then((community) => {
        if (cancelled) return;
        setLoad({ status: "ready", community });
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
    // `signedIn` is a dependency because `viewerIsMember` is derived from the
    // token this request carries: signing in in another tab must not leave a
    // stale "Masuk untuk gabung" on screen.
  }, [slug, signedIn]);

  if (load.status === "loading") {
    return (
      <>
        <Header title="Komunitas" />
        <main className="user-page community-page">
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
        <Header title="Komunitas" />
        <main className="user-page community-page">
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
      <Header title={community.name} />
      <main className="user-page community-page">
        <section className="community-banner">
          <span
            className="community-banner-tile"
            style={{
              background: communityColor(community.slug),
              color: communityInk(community.slug),
            }}
            aria-hidden="true"
          >
            {community.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="community-banner-body">
            <h1 className="community-banner-name">{community.name}</h1>
            {/* One line, one string: a screen reader reads "4 anggota, Skill
                Digital" rather than three fragments it has to reassemble. */}
            <p className="community-banner-meta">
              {community.memberCount} anggota · {community.category}
            </p>
            {community.description === null ? null : (
              <p className="community-banner-description">{community.description}</p>
            )}
          </div>
          <div className="community-banner-actions">
            <CommunityJoinControl
              slug={community.slug}
              viewerIsMember={community.viewerIsMember}
              viewerIsOwner={community.viewerIsOwner}
              onChanged={(member) =>
                setLoad({
                  status: "ready",
                  community: {
                    ...community,
                    viewerIsMember: member,
                    // Moved locally rather than re-fetched: the count is the
                    // one fact this action is known to have changed.
                    memberCount: community.memberCount + (member ? 1 : -1),
                  },
                })
              }
            />
          </div>
        </section>

        <nav className="feed-tabs" aria-label="Tampilan komunitas">
          <button type="button" aria-current={tab === "diskusi"} onClick={() => setParams({})}>
            Diskusi
          </button>
          <button
            type="button"
            aria-current={tab === "kegiatan"}
            onClick={() => setParams({ tab: "kegiatan" })}
          >
            Kegiatan
          </button>
          <button
            type="button"
            aria-current={tab === "dokumen"}
            onClick={() => setParams({ tab: "dokumen" })}
          >
            Dokumen
          </button>
          <button
            type="button"
            aria-current={tab === "keanggotaan"}
            onClick={() => setParams({ tab: "keanggotaan" })}
          >
            Keanggotaan
          </button>
          <button
            type="button"
            aria-current={tab === "anggota"}
            onClick={() => setParams({ tab: "anggota" })}
          >
            Anggota
          </button>
          {/* OWNER ONLY, and absent rather than disabled for everyone else —
              the rule Phase 1 set when it cut the tab bar rather than render
              tabs with nothing behind them. The server refuses a non-owner
              with 403 regardless; this is what stops the tab being offered. */}
          {community.viewerIsOwner ? (
            <button
              type="button"
              aria-current={tab === "statistik"}
              onClick={() => setParams({ tab: "statistik" })}
            >
              Statistik
            </button>
          ) : null}
        </nav>

        {/* Only the active tab is mounted, so opening the calendar does not
            fetch a feed nobody asked for — and vice versa. The rule Phase 2
            set when it added the first tab bar. */}
        {tab === "diskusi" ? (
          <CommunityFeed
            slug={community.slug}
            viewerIsMember={community.viewerIsMember}
            viewerIsOwner={community.viewerIsOwner}
          />
        ) : tab === "kegiatan" ? (
          <KegiatanTab slug={community.slug} />
        ) : tab === "statistik" && community.viewerIsOwner ? (
          <StatistikTab slug={community.slug} />
        ) : tab === "keanggotaan" ? (
          <CommunityTiers
            slug={community.slug}
            viewerIsOwner={community.viewerIsOwner}
            viewerIsMember={community.viewerIsMember}
          />
        ) : tab === "dokumen" ? (
          <DokumenTab
            slug={community.slug}
            viewerIsOwner={community.viewerIsOwner}
            viewerIsMember={community.viewerIsMember}
          />
        ) : (
          <AnggotaTab slug={community.slug} />
        )}
      </main>
    </>
  );
}
