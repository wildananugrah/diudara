import { useSyncExternalStore, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { getToken, subscribeToAuth } from "./auth";

/**
 * The gate every dashboard screen sits behind.
 *
 * It SUBSCRIBES to the session rather than reading it once, and that is the
 * load-bearing part. Two different things send a creator back to login:
 *
 *  - arriving with no token at all (a bookmarked deep URL, a fresh browser);
 *  - a token that has expired, discovered by a 401 from whatever the current
 *    screen was loading. `apiClient` clears the token, `auth.ts` notifies, this
 *    re-renders, and the redirect happens from inside the router.
 *
 * Reading `localStorage` once at mount would handle only the first. The second is
 * the one that bites: a seven-day token expires while a creator has the dashboard
 * open, and without this every panel shows an error with no way out.
 *
 * `state.from` carries only a PATH, never the token — it is what login sends the
 * creator back to once they are in.
 */
export default function RequireAuth({ children }: { children: ReactNode }) {
  // `getToken` returns a string or null, so the snapshot compares by value and
  // cannot loop. The third argument is the server snapshot; there is no SSR here,
  // and reading storage would throw on a server, so it returns null.
  const token = useSyncExternalStore(subscribeToAuth, getToken, () => null);
  const location = useLocation();

  if (token === null) {
    return (
      <Navigate
        to="/dashboard/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return <>{children}</>;
}
