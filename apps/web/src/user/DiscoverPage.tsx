import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { COMMUNITY_CATEGORIES, MAX_COMMUNITY_SEARCH_LENGTH } from "@diudara/shared";
import { browseCommunities, type CommunityListRow, type FollowListRow } from "./apiClient";
import CommunityCard from "./CommunityCard";
import { communityColor } from "./communityColor";
import FollowButton from "./FollowButton";
import Header from "./shell/Header";

/** The same, for the case where nothing has loaded yet and the whole screen is empty. */
const COMMUNITIES_FAILED_MESSAGE = "Gagal memuat komunitas. Coba lagi.";

/**
 * A single follower/following row — kept here (not in `FollowListPage.tsx`
 * itself) because it used to be shared with this page's own Orang tab
 * (people search), which Discover's redesign removed outright rather than
 * dropped into a hidden corner — see this page's own docstring. Still
 * imported from here by `FollowListPage.tsx` rather than duplicated, since
 * both screens render the exact same projection.
 *
 * **`viewerFollows` comes from the SERVER, per row.** The row is handed
 * straight to `FollowButton`, which is the only way `/@you/mengikuti` can
 * read "Mengikuti" on people you follow instead of offering to follow them
 * again. See `FollowListRow`'s own docstring in `apiClient.ts` for the
 * contract.
 */
export function FollowRow({ row }: { row: FollowListRow }) {
  return (
    <li className="follow-row card">
      <Link to={`/@${row.handle}`} className="follow-row-identity">
        <span className="follow-row-name">{row.displayName}</span>
        <span className="follow-row-handle muted">@{row.handle}</span>
      </Link>
      <FollowButton handle={row.handle} viewerFollows={row.viewerFollows} compact />
    </li>
  );
}

/**
 * The live-now strip's own card — never `CommunityCard`, which links to the
 * community's page: this links to the live room instead
 * (`/siaran/{live.streamId}`), because that is where "sedang berlangsung"
 * actually takes you. `community.live` is asserted non-null by every caller,
 * which only ever hands this component a row the caller already filtered on.
 */
function LiveNowCard({ community }: { community: CommunityListRow }) {
  const live = community.live!;
  return (
    <Link to={`/siaran/${live.streamId}`} className="card card-clickable discover-live-card">
      <div
        className="discover-live-card-banner"
        style={{ background: communityColor(community.slug) }}
      >
        <span className="badge badge-pending">
          <span className="dot" />
          LIVE
        </span>
        <span className="discover-live-card-viewers">{live.viewerCount} nonton</span>
      </div>
      <div className="discover-live-card-body">
        <p className="discover-live-card-name">{community.name}</p>
        <p className="muted">{community.category}</p>
      </div>
    </Link>
  );
}

/**
 * `/discover` — matching `docs/references/discover.png`: search, category
 * chips, a live-now strip, the community grid (`CommunityCard`, unchanged
 * from sub-project 1), and a sidebar (popular tags, a "create a community"
 * CTA). Community-only — this page used to also carry an Orang (people
 * search) tab, inherited unchanged from the page it replaced (Jelajah); it
 * was removed outright rather than hidden, and nothing in this app links to
 * people-search any more (see `BerandaPage.tsx`'s own empty-state, which lost
 * its link to it).
 *
 * Search is on SUBMIT: the query runs an `ILIKE '%…%'` over a grouped join,
 * which is not a thing to re-run per keystroke. The category chips are
 * different — one tap IS the whole intention, so they fetch immediately
 * rather than waiting for a second gesture nobody would understand.
 *
 * **The wide 1180px frame, only here.** `PageContainer`'s cap replaces
 * `.user-page`'s 36rem one — every other page keeps the narrow column; see
 * this phase's own spec for why this is the one page that adopts it.
 */
export default function DiscoverPage() {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [category, setCategory] = useState("");
  /** Bumped by every tap of "Cari Komunitas" so re-submitting the SAME text still re-runs the effect (React bails out of a `useState` set to an equal value otherwise). */
  const [attempt, setAttempt] = useState(0);
  const [communities, setCommunities] = useState<CommunityListRow[] | null>(null);
  /** The site's most-used tags, alongside `communities` in the same response — never re-fetched per search or category, since neither scopes it. */
  const [popularTags, setPopularTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    browseCommunities({ q: submittedQuery, category })
      .then((result) => {
        if (cancelled) return;
        setCommunities(result.communities);
        setPopularTags(result.popularTags);
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setError(COMMUNITIES_FAILED_MESSAGE);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [submittedQuery, category, attempt]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmittedQuery(query.trim());
    setAttempt((previous) => previous + 1);
  }

  const liveNow = communities?.filter((community) => community.live !== null) ?? [];

  return (
    <>
      <Header title="Discover" subtitle="Gabung komunitas yang cocok dengan minatmu" />
      <main className="page-container discover-page">
        <div className="discover-layout">
          <div className="discover-main">
            <form className="jelajah-search" onSubmit={handleSubmit} role="search">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value.slice(0, MAX_COMMUNITY_SEARCH_LENGTH))}
                maxLength={MAX_COMMUNITY_SEARCH_LENGTH}
                placeholder="Cari komunitas, topik, atau mentor..."
                aria-label="Cari komunitas"
              />
              <button type="submit" className="btn btn-primary">
                Cari Komunitas
              </button>
            </form>

            {/* Filter toggles, not navigation — `aria-pressed` rather than `aria-current`. */}
            <div className="category-chips" role="group" aria-label="Kategori komunitas">
              <button
                type="button"
                className="category-chip"
                aria-pressed={category === ""}
                onClick={() => setCategory("")}
              >
                Semua
              </button>
              {COMMUNITY_CATEGORIES.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="category-chip"
                  aria-pressed={category === name}
                  onClick={() => setCategory(category === name ? "" : name)}
                >
                  {name}
                </button>
              ))}
            </div>

            {loading ? <p>Memuat...</p> : null}

            {error !== null ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}

            {communities !== null && error === null ? (
              <>
                {liveNow.length > 0 ? (
                  <section className="discover-live-section">
                    <div className="discover-live-heading">
                      <span className="badge badge-pending">
                        <span className="dot" />
                        LIVE
                      </span>
                      <h2>Sedang berlangsung</h2>
                    </div>
                    <div className="discover-live-grid">
                      {liveNow.map((community) => (
                        <LiveNowCard key={community.slug} community={community} />
                      ))}
                    </div>
                  </section>
                ) : null}

                <h2 className="discover-grid-heading">
                  {category === "" ? "Semua komunitas" : category}
                  <span className="muted"> · {communities.length} hasil</span>
                </h2>
                {communities.length === 0 ? (
                  <p className="empty">Belum ada komunitas di sini.</p>
                ) : (
                  <div className="community-grid">
                    {communities.map((community) => (
                      <CommunityCard key={community.slug} community={community} />
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </div>

          <aside className="discover-sidebar">
            <div className="card discover-sidebar-card">
              <h4>Tag populer</h4>
              <div className="discover-tag-cloud">
                {popularTags.map((tag) => (
                  <span key={tag} className="badge badge-neutral">
                    #{tag}
                  </span>
                ))}
              </div>
            </div>

            <div className="card discover-cta-card">
              <p className="discover-cta-eyebrow">PUNYA KOMUNITAS SENDIRI?</p>
              <p>Setup komunitas berbayar kamu dalam 15 menit bareng Pulse-ID.</p>
              <Link to="/komunitas/baru" className="btn btn-primary btn-sm">
                Mulai sekarang <span aria-hidden="true">→</span>
              </Link>
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}
