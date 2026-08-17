import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { exploreUsers, getSessionUser, type FollowListRow } from "./apiClient";
import FollowButton from "./FollowButton";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      results: FollowListRow[];
      newest: FollowListRow[];
      mostFollowed: FollowListRow[];
    };

/**
 * A single follower/following/search row — shared between this page and
 * `FollowListPage.tsx` (imported from there rather than duplicated, since
 * both screens render the exact same `FollowListRow` projection).
 *
 * **The per-row `FollowButton` cannot know the real per-row follow state.**
 * None of the three endpoints these rows come from (`/explore`,
 * `/:handle/followers`, `/:handle/following`) return a per-row
 * `viewerFollows` — only the single profile fetch does (Task 2's
 * `PublicUserProfile`). A signed-out visitor still gets the correct `null`
 * ("Masuk untuk mengikuti"); a signed-in visitor's rows start assuming
 * "not following" even for someone already followed, self-correcting the
 * moment they tap it — the resulting state always comes back from the real
 * `POST`/`DELETE` response, never guessed again after that. Fixing the
 * initial-state gap would need a wider list endpoint; out of scope here.
 * `FollowButton` itself still hides correctly on the viewer's own row,
 * since that check compares handles, not this guessed value.
 */
export function FollowRow({ row }: { row: FollowListRow }) {
  const signedIn = getSessionUser() !== null;
  return (
    <li className="follow-row card">
      <Link to={`/@${row.handle}`} className="follow-row-identity">
        <span className="follow-row-name">{row.displayName}</span>
        <span className="follow-row-handle muted">@{row.handle}</span>
      </Link>
      <FollowButton handle={row.handle} viewerFollows={signedIn ? false : null} />
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
 * `/jelajah` — Task 5. Search by handle or display name, plus two
 * always-populated discovery rails (design spec §4): "Akun terbaru" and
 * "Paling banyak diikuti". Search is on SUBMIT, not on every keystroke — a
 * live input would re-run `GET /explore`'s whole-table `GROUP BY` (Task 3's
 * `mostFollowedPublic`) on every character, which Task 3's own review
 * measured as a full sequential scan rather than an index-only one.
 *
 * An empty query is the screen's DEFAULT state, not an error — it mirrors
 * `ExploreUsers.execute`'s own contract exactly: `results` stays empty (and
 * the "Hasil pencarian" section is not shown at all) while the two rails
 * still load.
 */
export default function JelajahPage() {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    exploreUsers({ q: submittedQuery })
      .then((result) => {
        if (!cancelled) setLoad({ status: "ready", ...result });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({ status: "error", message: err instanceof Error ? err.message : "gagal memuat Jelajah" });
      });
    return () => {
      cancelled = true;
    };
  }, [submittedQuery]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmittedQuery(query.trim());
  }

  return (
    <main className="user-page jelajah-page">
      <h1>Jelajah</h1>

      <form className="jelajah-search" onSubmit={handleSubmit} role="search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cari nama atau handle"
          aria-label="Cari nama atau handle"
        />
        <button type="submit" className="button-primary">
          Cari
        </button>
      </form>

      {load.status === "loading" ? <p>Memuat...</p> : null}

      {load.status === "error" ? (
        <p className="form-error" role="alert">
          {load.message}
        </p>
      ) : null}

      {load.status === "ready" ? (
        <>
          {submittedQuery.length > 0 ? (
            <section className="section">
              <h2>Hasil pencarian</h2>
              <FollowRowList rows={load.results} empty={`Tidak ada hasil untuk "${submittedQuery}".`} />
            </section>
          ) : null}

          <section className="section">
            <h2>Akun terbaru</h2>
            <FollowRowList rows={load.newest} empty="Belum ada akun." />
          </section>

          <section className="section">
            <h2>Paling banyak diikuti</h2>
            <FollowRowList rows={load.mostFollowed} empty="Belum ada akun." />
          </section>
        </>
      ) : null}
    </main>
  );
}
