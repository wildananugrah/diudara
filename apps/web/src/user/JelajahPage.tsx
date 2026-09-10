import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  COMMUNITY_CATEGORIES,
  MAX_COMMUNITY_SEARCH_LENGTH,
  MAX_EXPLORE_QUERY_LENGTH,
} from "@diudara/shared";
import {
  browseCommunities,
  exploreUsers,
  type CommunityListRow,
  type FollowListRow,
} from "./apiClient";
import CommunityCard from "./CommunityCard";
import FollowButton from "./FollowButton";
import Header from "./shell/Header";

/**
 * The two discovery rails, which do not depend on `q` at all — see
 * `ExploreUsers`' own docstring: `newest` and `mostFollowed` come back
 * populated whether or not anything was searched.
 *
 * Held as their OWN state, replaced only on a successful response (final
 * review I3). They used to share one `LoadState` union with the search, so
 * `status: "error"` replaced the entire page and a failed SEARCH took down two
 * rails that had already loaded — measured: `"Akun terbaru" headings still on
 * screen = 0`, `rail rows still on screen = 0`. `null` means "nothing has ever
 * loaded", which is the only state where an error legitimately owns the whole
 * screen because there is nothing to preserve.
 */
type Rails = { newest: FollowListRow[]; mostFollowed: FollowListRow[] } | null;

/**
 * Shown when the request behind a SUBMITTED search fails. Bahasa Indonesia, and
 * this page's own sentence rather than `readError`'s lifted `{ error }` string:
 * that string is Zod-derived English (`"invalid query: q must be at most 100
 * characters, limit must be an integer between 1 and 100"`, measured against
 * the real route) and the copy rule is project-wide.
 */
const SEARCH_FAILED_MESSAGE = "Pencarian gagal. Coba lagi.";

/** The same, for the case where nothing has loaded yet and the whole screen is empty. */
const LOAD_FAILED_MESSAGE = "Gagal memuat Jelajah. Coba lagi.";

/** The same again, for the Komunitas tab. */
const COMMUNITIES_FAILED_MESSAGE = "Gagal memuat komunitas. Coba lagi.";

/**
 * A single follower/following/search row — shared between this page and
 * `FollowListPage.tsx` (imported from there rather than duplicated, since both
 * screens render the exact same projection).
 *
 * **`viewerFollows` now comes from the SERVER, per row.** This component used to
 * guess it — `signedIn ? false : null` — because none of `/explore`,
 * `/:handle/followers` or `/:handle/following` returned a per-row value. The
 * final review's item 1 widened all three, so the guess is gone: the row is
 * handed straight to `FollowButton`, which is the only way `/@you/mengikuti` can
 * read "Mengikuti" on people you follow instead of offering to follow them
 * again. See `FollowListRow`'s own docstring in `apiClient.ts` for the contract.
 *
 * The viewer's OWN row (reachable on `/jelajah`, where your account appears in
 * "Akun terbaru") arrives as `false`, since nobody follows themselves —
 * `FollowButton` renders nothing at all for it by comparing handles, never by
 * reading this value. That is the ledger's binding ruling and the reason a
 * self-row shows no control rather than a button that 409s.
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

function FollowRowList({ rows, empty }: { rows: FollowListRow[]; empty: string }) {
  if (rows.length === 0) {
    return <p className="empty">{empty}</p>;
  }
  return (
    <ul className="card-list follow-list">
      {rows.map((row) => (
        <FollowRow key={row.handle} row={row} />
      ))}
    </ul>
  );
}

/**
 * The Komunitas half — Phase 1, and the DEFAULT tab.
 *
 * Search is on SUBMIT for the same reason the Orang half's is: the query runs
 * an `ILIKE '%…%'` over a grouped join, which is not a thing to re-run per
 * keystroke. The category chips are different — one tap IS the whole
 * intention, so they fetch immediately rather than waiting for a second
 * gesture nobody would understand.
 *
 * A component of its own rather than a branch inside the page, so its effect
 * does not exist at all while the Orang tab is showing. A single component
 * holding both tabs' hooks would fetch communities for a visitor who only ever
 * opened `?tab=orang`.
 */
function KomunitasTab() {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [category, setCategory] = useState("");
  /** Bumped by every tap of "Cari" — see the Orang half's own `attempt` for why re-submitting the same text must still re-run the effect. */
  const [attempt, setAttempt] = useState(0);
  const [communities, setCommunities] = useState<CommunityListRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    browseCommunities({ q: submittedQuery, category })
      .then((result) => {
        if (cancelled) return;
        setCommunities(result.communities);
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

  return (
    <>
      <form className="jelajah-search" onSubmit={handleSubmit} role="search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value.slice(0, MAX_COMMUNITY_SEARCH_LENGTH))}
          maxLength={MAX_COMMUNITY_SEARCH_LENGTH}
          placeholder="Cari komunitas"
          aria-label="Cari komunitas"
        />
        <button type="submit" className="button-primary">
          Cari
        </button>
      </form>

      {/*
        `aria-pressed` rather than `aria-current`: these are filter toggles, not
        navigation, and only the tab strip above represents where you are.
      */}
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
        communities.length === 0 ? (
          <p className="empty">Belum ada komunitas di sini.</p>
        ) : (
          <div className="community-grid">
            {communities.map((community) => (
              <CommunityCard key={community.slug} community={community} />
            ))}
          </div>
        )
      ) : null}
    </>
  );
}

/**
 * The Orang half — Task 5's original Jelajah, unchanged in behaviour and moved
 * whole into a tab. Search by handle or display name, plus two
 * always-populated discovery rails (design spec §4): "Akun terbaru" and
 * "Paling banyak diikuti". Search is on SUBMIT, not on every keystroke — a
 * live input would re-run `GET /explore`'s whole-table `GROUP BY` (Task 3's
 * `mostFollowedPublic`) on every character, which Task 3's own review
 * measured as a full sequential scan rather than an index-only one.
 *
 * An empty query is this half's DEFAULT state, not an error — it mirrors
 * `ExploreUsers.execute`'s own contract exactly: `results` stays empty (and
 * the "Hasil pencarian" section is not shown at all) while the two rails
 * still load.
 *
 * **The query is bounded at `MAX_EXPLORE_QUERY_LENGTH`, the same shared
 * constant the route enforces** (final review I3). Both the `maxLength`
 * attribute and the state itself clamp: the attribute is what a real paste
 * respects, and the clamp is what makes an over-long request impossible even
 * when the value is set programmatically. And a failed request now leaves
 * whatever loaded successfully in place — see `Rails` above.
 */
function OrangTab() {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  /**
   * Bumped by every tap of "Cari" and read ONLY by the effect's dependency
   * list, which is exactly what it is for. Keying the fetch on
   * `submittedQuery` alone made re-submitting the SAME text a no-op — React
   * bails out of a `useState` set to an equal value, so the effect never re-ran
   * — and a screen that says "Coba lagi" ("try again") which cannot be tried
   * again is worse than one that says nothing. Found while writing item 5's
   * tests, not reported by the review.
   */
  const [attempt, setAttempt] = useState(0);
  const [rails, setRails] = useState<Rails>(null);
  const [results, setResults] = useState<FollowListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    exploreUsers({ q: submittedQuery })
      .then((result) => {
        if (cancelled) return;
        setRails({ newest: result.newest, mostFollowed: result.mostFollowed });
        setResults(result.results);
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        // Deliberately does NOT touch `rails`: whatever loaded before this
        // request stays on screen. `results` IS cleared — leaving the previous
        // query's hits under a new query's heading would be a different lie.
        setResults([]);
        setError(submittedQuery.length > 0 ? SEARCH_FAILED_MESSAGE : LOAD_FAILED_MESSAGE);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `attempt` is in here on purpose — see its own comment above. Re-running
    // this effect on an unchanged query is the retry.
  }, [submittedQuery, attempt]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmittedQuery(query.trim());
    setAttempt((previous) => previous + 1);
  }

  const searchFailed = error !== null && submittedQuery.length > 0;

  return (
    <>
      <form className="jelajah-search" onSubmit={handleSubmit} role="search">
        <input
          type="search"
          value={query}
          // Clamped here as well as by `maxLength`: the attribute bounds typing
          // and pasting in a real browser, this bounds every other way a value
          // can arrive.
          onChange={(e) => setQuery(e.target.value.slice(0, MAX_EXPLORE_QUERY_LENGTH))}
          maxLength={MAX_EXPLORE_QUERY_LENGTH}
          placeholder="Cari nama atau handle"
          aria-label="Cari nama atau handle"
        />
        <button type="submit" className="button-primary">
          Cari
        </button>
      </form>

      {loading ? <p>Memuat...</p> : null}

      {/* Nothing has ever loaded, so the error legitimately owns the screen. */}
      {error !== null && rails === null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {rails !== null ? (
        <>
          {submittedQuery.length > 0 ? (
            <section className="section">
              <h2>Hasil pencarian</h2>
              {searchFailed ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : (
                <FollowRowList rows={results} empty={`Tidak ada hasil untuk "${submittedQuery}".`} />
              )}
            </section>
          ) : null}

          <section className="section">
            <h2>Akun terbaru</h2>
            <FollowRowList rows={rails.newest} empty="Belum ada akun." />
          </section>

          <section className="section">
            <h2>Paling banyak diikuti</h2>
            <FollowRowList rows={rails.mostFollowed} empty="Belum ada akun." />
          </section>
        </>
      ) : null}
    </>
  );
}

/**
 * `/jelajah` — one discovery surface with two halves, Komunitas and Orang.
 *
 * **ONE PAGE RATHER THAN TWO MENU ENTRIES.** Two near-identical search boxes on
 * adjacent sidebar items is the kind of thing a person picks wrong every time,
 * and the sidebar stays at four entries instead of growing toward seven.
 *
 * **The tab lives in the URL**, not in component state, so a link to either
 * half is shareable and the back button steps between them — the same
 * arrangement Beranda's "Untuk Anda"/"Mengikuti" pair uses, down to reusing its
 * `.feed-tabs` markup and classes so the indicator invariant
 * `BerandaPage.test.tsx` pins covers this page too.
 *
 * Komunitas is the default: `/jelajah` with no query string is the community
 * grid, and Orang is `?tab=orang`. Only the active half is mounted, so the
 * inactive one issues no request at all.
 */
export default function JelajahPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "orang" ? "orang" : "komunitas";

  return (
    <>
      <Header title="Jelajah" />
      <main className="user-page jelajah-page">
        <nav className="feed-tabs" aria-label="Jenis jelajah">
          <button type="button" aria-current={tab === "komunitas"} onClick={() => setParams({})}>
            Komunitas
          </button>
          <button
            type="button"
            aria-current={tab === "orang"}
            onClick={() => setParams({ tab: "orang" })}
          >
            Orang
          </button>
        </nav>

        {tab === "komunitas" ? <KomunitasTab /> : <OrangTab />}
      </main>
    </>
  );
}
