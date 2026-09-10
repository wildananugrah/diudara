import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import NotFoundPage from "../pages/NotFoundPage";
import {
  UserApiError,
  getCommunity,
  getSessionUser,
  joinCommunity,
  leaveCommunity,
  listCommunityMembers,
  type CommunityDetail,
  type CommunityMemberRow,
} from "./apiClient";
import { communityColor, communityInk } from "./communityColor";
import { describeCommunityFailure, describeRequestFailure } from "./errorCopy";
import Header from "./shell/Header";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; community: CommunityDetail };

/**
 * The join control, in its three mutually exclusive shapes.
 *
 * **The owner gets NOTHING — not a disabled button.** `DELETE
 * /communities/:slug/join` answers 409 for an owner every time, and this
 * project's rule is that a control is never rendered for an action that would
 * fail. A greyed-out *Keluar* would still say "this is a thing you could do
 * if only something were different", which is not true here and never will be.
 *
 * A signed-out visitor gets a LINK to `/masuk`, not a button: tapping it
 * cannot join anything, so it should navigate rather than fail. That is the
 * whole reason `viewerIsMember` is `null` rather than `false` for them —
 * `false` means "signed in, not a member", which is the one case that gets a
 * working *Gabung*.
 */
function JoinControl({
  community,
  onChanged,
}: {
  community: CommunityDetail;
  onChanged: (member: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (community.viewerIsOwner) return null;
  if (community.viewerIsMember === null) {
    return (
      <Link className="button-primary btn btn-sm" to="/masuk">
        Masuk untuk gabung
      </Link>
    );
  }

  const member = community.viewerIsMember;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const result = member
        ? await leaveCommunity(community.slug)
        : await joinCommunity(community.slug);
      onChanged(result.member);
    } catch (err) {
      setError(describeCommunityFailure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={member ? "button-secondary btn btn-sm" : "button-primary btn btn-sm"}
        onClick={toggle}
        disabled={busy}
      >
        {member ? "Keluar" : "Gabung"}
      </button>
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

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
 * `/komunitas/:slug` — a community's own page.
 *
 * **NO TAB BAR.** One tab is not a tab bar, and this page has exactly one
 * thing on it: who is in the community. Phase 2 adds the feed and the tabs
 * that then earn their place.
 *
 * Loading, not-found and error are three separate early returns, the shape
 * `ProfilePage` already uses. A 404 renders the SAME shared `NotFoundPage`
 * every other unknown URL gets, with no hint that the slug happens to be free.
 *
 * The roster is fetched alongside the detail and fails SILENTLY: a community
 * that loaded is not broken because its member list was unreachable, and an
 * empty roster under a working banner is a smaller lie than an error page over
 * a community that exists.
 */
export default function CommunityPage() {
  const { slug } = useParams<{ slug: string }>();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [members, setMembers] = useState<CommunityMemberRow[]>([]);
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

  useEffect(() => {
    if (slug === undefined) return;
    let cancelled = false;
    listCommunityMembers(slug)
      .then((result) => {
        if (!cancelled) setMembers(result.members);
      })
      .catch(() => {
        // Silent by design — see the component docstring.
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

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
            <JoinControl
              community={community}
              onChanged={(member) =>
                setLoad({
                  status: "ready",
                  community: {
                    ...community,
                    viewerIsMember: member,
                    // Moved locally rather than re-fetched: the count is the
                    // one fact this action is known to have changed, and a
                    // second round trip to learn it would leave the number
                    // stale for as long as it took.
                    memberCount: community.memberCount + (member ? 1 : -1),
                  },
                })
              }
            />
          </div>
        </section>

        <section className="section">
          <h2>Anggota</h2>
          <Roster members={members} />
        </section>
      </main>
    </>
  );
}
