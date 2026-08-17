import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DEFAULT_FOLLOW_LIST_LIMIT } from "@diudara/shared";
import NotFoundPage from "../pages/NotFoundPage";
import { listFollowers, listFollowing, UserApiError, type FollowListRow } from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import { FollowRow } from "./JelajahPage";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: FollowListRow[] };

const TITLE: Record<"followers" | "following", string> = {
  followers: "Pengikut",
  following: "Mengikuti",
};

const EMPTY_MESSAGE: Record<"followers" | "following", string> = {
  followers: "Belum ada pengikut.",
  following: "Belum mengikuti siapa pun.",
};

/**
 * Said when the page comes back FULL — final review M1, measured against the real
 * routes: a profile reading "55 Pengikut", tapped, listed 50 rows with no
 * pagination, no "and 5 more", and no error.
 *
 * Pagination is explicitly out of scope (design spec §5: these lists are capped,
 * with no infinite scroll), so the ruling was to be honest instead. "mungkin"
 * ("may") rather than a flat claim, because a full page is not proof of a
 * remainder: somebody with exactly 50 followers sees this and nothing is hidden
 * from them. The client asks for no `?limit=`, so the count it compares against
 * is the server's own default — hence one shared constant rather than a 50
 * written here.
 */
const CAPPED_MESSAGE = `Daftar dibatasi ${DEFAULT_FOLLOW_LIST_LIMIT} akun, jadi mungkin ada yang tidak ditampilkan.`;

/**
 * The way off this page — see the component docstring for why it has to exist.
 * Names the handle rather than saying only "Kembali", so it still reads
 * correctly after a visitor has scrolled a long list, and so it replaces the
 * bare `<p className="muted">@handle</p>` that used to sit under the heading
 * rather than repeating it. The `@` matches how every other surface in this
 * app writes a handle.
 */
function BackToProfile({ handle }: { handle: string }) {
  return (
    <p className="follow-list-back">
      <Link to={`/@${handle}`}>Kembali ke @{handle}</Link>
    </p>
  );
}

/**
 * `/@:handle/pengikut` and `/@:handle/mengikuti` (Task 5) — reachable by
 * tapping either count on `ProfilePage`. `direction` picks which of the two
 * this instance serves; `App.tsx` mounts the same component twice, once per
 * path, rather than parsing the trailing segment here.
 *
 * Same `path="/:handleParam/..."` + leading-`@`-check shape as
 * `ProfilePage.tsx` — see that component's own docstring for why React
 * Router cannot match a literal `@` glued to a param inside one path
 * segment, and why the leading `@` is this component's own job to check
 * rather than the router's.
 *
 * Both routes are TWO segments deep (`/:handleParam/pengikut`), strictly
 * more specific than the bare one-segment `/:handleParam` profile route —
 * React Router ranks static segments (and more of them) above a shorter
 * dynamic match regardless of registration order, so these can never be
 * shadowed by it.
 *
 * **Renders OUTSIDE the app shell, and carries its own back link** (final
 * review I1's design question, ruled). Outside the shell is consistent with
 * `/@handle`, which is also outside — but unlike `/@handle`, which people
 * arrive at from a shared URL, these two pages are reachable ONLY by tapping a
 * count on a profile, so with no shell AND no back link they were a dead end
 * on a phone: browser-back or a row's own `/@handle` link were the only ways
 * out. `BackToProfile` below is rendered in every state a visitor can be
 * stranded in. The shell exclusion itself is pinned in `App.test.tsx` — both
 * per-route and as a whole-table partition.
 */
export default function FollowListPage({ direction }: { direction: "followers" | "following" }) {
  const { handleParam } = useParams<{ handleParam: string }>();
  const isProfileUrl = typeof handleParam === "string" && handleParam.startsWith("@");
  const handle = isProfileUrl ? handleParam.slice(1) : "";
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!isProfileUrl) return;
    let cancelled = false;
    setLoad({ status: "loading" });
    const fetchRows = direction === "followers" ? listFollowers : listFollowing;
    fetchRows(handle)
      .then((rows) => {
        if (!cancelled) setLoad({ status: "ready", rows });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof UserApiError && err.status === 404) {
          setLoad({ status: "not-found" });
        } else {
          // N1: see `ProfilePage`'s identical note and `errorCopy.ts`. This
          // component printed `"internal server error"` under its own
          // "Gagal memuat daftar" heading, measured on a real 500.
          setLoad({ status: "error", message: describeRequestFailure(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isProfileUrl, handle, direction]);

  if (!isProfileUrl || load.status === "not-found") {
    return <NotFoundPage />;
  }

  if (load.status === "loading") {
    return (
      <main className="user-page">
        <p>Memuat...</p>
      </main>
    );
  }

  if (load.status === "error") {
    return (
      <main className="user-page">
        <BackToProfile handle={handle} />
        <h1>Gagal memuat daftar</h1>
        <p>{load.message}</p>
      </main>
    );
  }

  return (
    <main className="user-page">
      <BackToProfile handle={handle} />
      <h1>{TITLE[direction]}</h1>
      {load.rows.length === 0 ? (
        <p className="empty">{EMPTY_MESSAGE[direction]}</p>
      ) : (
        <>
          <ul className="card-list follow-list">
            {load.rows.map((row) => (
              <FollowRow key={row.handle} row={row} />
            ))}
          </ul>
          {load.rows.length >= DEFAULT_FOLLOW_LIST_LIMIT ? (
            <p className="muted follow-list-capped">{CAPPED_MESSAGE}</p>
          ) : null}
        </>
      )}
    </main>
  );
}
