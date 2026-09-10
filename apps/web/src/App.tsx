import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import NotFoundPage from "./pages/NotFoundPage";
import UserSignupPage from "./user/SignupPage";
import UserLoginPage from "./user/LoginPage";
import SettingsPage from "./user/SettingsPage";
import ResetRequestPage from "./user/ResetRequestPage";
import ResetCompletePage from "./user/ResetCompletePage";
import ProfilePage from "./user/ProfilePage";
import FollowListPage from "./user/FollowListPage";
import AppShell from "./user/AppShell";
import RedirectIfSignedIn from "./user/RedirectIfSignedIn";
import BerandaPage from "./user/BerandaPage";
import SiaranPage from "./user/SiaranPage";
import JelajahPage from "./user/JelajahPage";
import CommunityPage from "./user/CommunityPage";
import CommunityCreatePage from "./user/CommunityCreatePage";
import DiscussionPage from "./user/DiscussionPage";
import { loadPostImageLimit, repairSplitSession } from "./user/apiClient";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />

      {/*
        Task 6: personal accounts — their own session, independent of the
        landing page above (see user/apiClient.ts's own docstring). All
        public, rendered OUTSIDE the shell below: no session, so no
        navigation.
      */}
      <Route
        path="/signup"
        element={
          <RedirectIfSignedIn>
            <UserSignupPage />
          </RedirectIfSignedIn>
        }
      />
      <Route
        path="/masuk"
        element={
          <RedirectIfSignedIn>
            <UserLoginPage />
          </RedirectIfSignedIn>
        }
      />
      {/*
        The two below are deliberately NOT wrapped. `SettingsPage` has no
        password change, so these are the only route to a new password, and
        forgetting a password does not end an existing browser session — a
        signed-in visitor is exactly who follows the emailed link. Guarding
        them would lock a signed-in user out of recovery; guarding both would
        make it impossible. `App.test.tsx` asserts this absence rather than
        leaving it to be "tidied up" later.
      */}
      <Route path="/lupa-sandi" element={<ResetRequestPage />} />
      <Route path="/reset/:token" element={<ResetCompletePage />} />

      {/*
        Task 4: the app shell — see AppShell.tsx and
        docs/superpowers/specs/2026-08-17-member-ui-design.md §3. A path-less
        layout route, so every child below renders inside the shared bottom
        bar / side rail. /pengaturan moves in here from the block above;
        SettingsPage keeps its own session guard unchanged (see
        SettingsPage.tsx), so a signed-out visit to any of these four still
        lands on /masuk — just via a route now nested one level deeper.

        The public profile and the two follow lists moved in here on
        2026-08-25 — see their own comment below for why the rule that kept
        them out had expired.
      */}
      <Route element={<AppShell />}>
        <Route path="/beranda" element={<BerandaPage />} />
        <Route path="/jelajah" element={<JelajahPage />} />
        <Route path="/siaran" element={<SiaranPage />} />
        <Route path="/pengaturan" element={<SettingsPage />} />

        {/*
          Phase 1's communities. `/komunitas/baru` is declared BEFORE
          `/komunitas/:slug` so the literal wins — belt and braces, since React
          Router ranks a static segment above a dynamic one regardless of
          declaration order, and since `baru` is a RESERVED SLUG
          (`apps/api/src/domain/community-slug.ts`) that no community can hold.
          Two independent guarantees for one URL, because the failure mode is a
          create form nobody can reach.

          Both sit above the catch-all `/:handleParam` further down, which
          matches a single segment and so could never have claimed a two-segment
          path anyway.
        */}
        <Route path="/komunitas/baru" element={<CommunityCreatePage />} />
        <Route path="/komunitas/:slug" element={<CommunityPage />} />
        {/*
          Task 9 (ruling R11): a community post on its own page, with its comment
          thread — the link every Diskusi-tab card carries. Declared AFTER
          `/komunitas/:slug` and (like every route in this block) above the
          catch-all `/:handleParam`, which matches a single segment and could
          never have claimed this three-segment path anyway.
        */}
        <Route path="/komunitas/:slug/diskusi/:postId" element={<DiscussionPage />} />

        {/*
          MOVED INSIDE THE SHELL on 2026-08-25, reversing an earlier ruling.

          Spec §3's rule is "no navigation when there is no session", and it
          names exactly four pages: signup, login, and the two reset pages. A
          later ruling generalised it to the public profile as well — but that
          rule was written before `useDestinations` (AppShell.tsx) computed the
          fourth destination FROM the session: signed out it reads "Masuk" ->
          /masuk rather than "Profil". A public page can therefore carry the
          nav without offering a signed-out visitor a door that is not there,
          which was the only thing the rule was protecting against. The four
          auth pages stay outside for a reason that has NOT expired: a nav
          there is noise whose fourth item points at the page you are on.

          What forced it: `/@handle` is where a membership is bought, and
          outside the shell it renders no navigation on any viewport — no side
          rail above 768px, no bottom bar below it. On a phone that leaves the
          browser's Back button as the only way out of the page the whole
          paid-membership flow ends on.

          The two follow lists come along because they are reachable ONLY by
          tapping a count on a profile; leaving them behind would make the
          navigation vanish on tap and reappear on Back.

          Ordering below is unchanged and still deliberate — two-segment paths
          ahead of the bare "/:handleParam", which stays last. Nesting does not
          affect matching (React Router ranks the flattened tree, so the static
          paths above still outrank this dynamic one regardless of where they
          are declared), and `App.test.tsx` pins both the ranking and the
          shell boundary itself.
        */}
        <Route path="/:handleParam/pengikut" element={<FollowListPage direction="followers" />} />
        <Route path="/:handleParam/mengikuti" element={<FollowListPage direction="following" />} />

        {/*
          THE PROFILE ROUTE — path="/:handleParam", NOT path="/@:handle".
          React Router cannot match a literal glued to a parameter inside one
          path segment, so "/@:handle" would never match "/@wildan" at all.
          ProfilePage itself renders the 404 page unless the param starts
          with "@", and strips it before calling the API.

          Registered LAST among the shell's children, immediately before the
          catch-all below: a single-segment dynamic route would otherwise be
          free to shadow /signup, /masuk, and every other one-segment path
          above. React Router actually ranks static segments above dynamic
          ones regardless of declaration order, so this ordering is defensive
          rather than load-bearing — but it is exactly the ordering whose
          absence would silently break /masuk, so it is kept here anyway and
          covered by its own routing test.
        */}
        <Route path="/:handleParam" element={<ProfilePage />} />
      </Route>

      {/* Rendered IN PLACE, never redirected: the URL the visitor typed has to
          stay in the address bar or the message cannot be acted on. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

/**
 * Task 7: repairs a split session (a token with no cached account) once, at
 * the root, above the router — so it covers `/@handle` and `/jelajah` alike,
 * the two surfaces where the bad state is visible sit on opposite sides of
 * the `AppShell` boundary. See `repairSplitSession`'s own docstring for why
 * this fixes the CAUSE rather than patching each screen.
 *
 * Fix round 1, IMPORTANT 1: fixing `localStorage` was not the whole job.
 * `getSessionUser()`'s three consumers (`FollowButton`, `ProfilePage`,
 * `BerandaPage`) are plain, unsubscribed, render-time reads — they only ever
 * see the corrected session on a render that happens to occur AFTER the
 * repair resolves, and nothing forced one: `notify()` only wakes
 * `useSyncExternalStore` subscribers, and the only ones in this app snapshot
 * `isUserSignedIn()`/`getUserToken()`, values the repair does not change
 * (the token was already present in the split state). So whether the stale
 * "Ikuti" on your own profile disappeared was a pure race against
 * `ProfilePage`'s own fetch — one React's child-before-parent effect
 * ordering loses by default. `setRepaired` bumps state HERE, at the same one
 * call site, once the repair's promise settles, so the whole tree gets
 * exactly one extra render pass with the corrected session already in
 * storage — still fixed at the cause, not by subscribing three separate
 * screens to session changes.
 */
export default function App() {
  const [, setRepaired] = useState(0);
  useEffect(() => {
    void repairSplitSession().then(() => setRepaired((n) => n + 1));
    // Task 8, spec §6: the web is a static build served by nginx and cannot
    // read the API's `MAX_POST_IMAGES`, so it asks once, here, at boot. It
    // CANNOT fail — a dead endpoint leaves the built-in fallback in place and
    // every composer works — and it needs no re-render of its own: composers
    // subscribe to the value, unlike the session repair above.
    void loadPostImageLimit();
  }, []);

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
