import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { isUserSignedIn } from "./apiClient";

/**
 * Where a session belongs when nothing more specific was asked for: the feed.
 *
 * Exported because `LoginPage` needs the same answer for its post-login
 * `destination` default, and these two drifting apart is exactly the bug this
 * file exists to end — `/masuk` used to send an already-signed-in visitor to
 * `/` (the marketing landing page) while a fresh login on the same page went
 * to `/@{handle}`. Two answers, one question, neither of them the feed.
 */
export const SIGNED_IN_HOME = "/beranda";

/**
 * Wraps a page meant for people who are NOT signed in, and turns away the
 * people who are.
 *
 * Applied in `App.tsx` at the route table rather than inside each page, so
 * that the set of guarded routes is visible in one place and can be asserted
 * as a whole — see `App.test.tsx`'s guarded-route partition test. `/masuk`
 * previously carried its own private copy of this check, which is how it
 * managed to redirect somewhere useless for months without anything noticing.
 *
 * NOT applied to `/lupa-sandi` or `/reset/:token`, on purpose. `SettingsPage`
 * offers no password change, so those two are the only path to a new
 * password — and forgetting a password does not end an existing browser
 * session, so a signed-in visitor is precisely who arrives at them. Turning
 * them away would lock them out of recovery entirely.
 *
 * Reads `isUserSignedIn()` at render rather than subscribing: this decides
 * where a navigation lands, and a session that changes afterwards produces
 * its own navigation.
 */
export default function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  if (isUserSignedIn()) {
    return <Navigate to={SIGNED_IN_HOME} replace />;
  }
  return <>{children}</>;
}
