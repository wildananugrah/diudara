import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import LandingPage from "./pages/LandingPage";
import NotFoundPage from "./pages/NotFoundPage";
import CheckoutPage from "./pages/CheckoutPage";
import StatusPage from "./pages/StatusPage";
import RequestStatusPage from "./pages/RequestStatusPage";
import WatchPage from "./pages/WatchPage";
import DashboardLayout from "./dashboard/DashboardLayout";
import LoginPage from "./dashboard/LoginPage";
import RequireAuth from "./dashboard/RequireAuth";
import CommunitiesPage from "./dashboard/pages/CommunitiesPage";
import CommunityOverviewPage from "./dashboard/pages/CommunityOverviewPage";
import TiersPage from "./dashboard/pages/TiersPage";
import ChannelsPage from "./dashboard/pages/ChannelsPage";
import AccountPage from "./dashboard/pages/AccountPage";
import MembersPage from "./dashboard/pages/MembersPage";
import ActivityPage from "./dashboard/pages/ActivityPage";
import CoBuilderPage from "./dashboard/pages/CoBuilderPage";
import EventsPage from "./dashboard/pages/EventsPage";
import UserSignupPage from "./user/SignupPage";
import UserLoginPage from "./user/LoginPage";
import SettingsPage from "./user/SettingsPage";
import ResetRequestPage from "./user/ResetRequestPage";
import ResetCompletePage from "./user/ResetCompletePage";
import ProfilePage from "./user/ProfilePage";
import FollowListPage from "./user/FollowListPage";
import AppShell from "./user/AppShell";
import BerandaPage from "./user/BerandaPage";
import SiaranPage from "./user/SiaranPage";
import JelajahPage from "./user/JelajahPage";
import { repairSplitSession } from "./user/apiClient";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />

      {/* react-router v7 ranks routes by specificity regardless of
          declaration order, so this 3-segment route always wins over
          /c/:slug for a URL like /c/kelas-budi/status/sub-1 — listed first
          here only for readability, not because order is load-bearing. */}
      <Route path="/c/:slug/status/:subscriptionId" element={<StatusPage />} />
      {/* The free-community counterpart: where a member lands right after
          asking to join instead of paying (Task 6). Same 3-segment
          specificity as the route above, for the same reason. */}
      <Route path="/c/:slug/request/:joinRequestId" element={<RequestStatusPage />} />
      <Route path="/c/:slug" element={<CheckoutPage />} />

      {/* Task 8: the member watch page. A bare, standalone route — not
          nested under /c — because a `/watch/<token>` URL is delivered on
          its own (a WhatsApp message, the status page's "Tonton sekarang"
          link) and has to work with nothing else in the address. */}
      <Route path="/watch/:token" element={<WatchPage />} />

      {/*
        THE CREATOR DASHBOARD, under /dashboard.

        The prefix is chosen so it cannot collide with an API path the way /c
        did: the API mounts /auth, /communities, /payment-account, /c, /webhooks
        and /health, and nothing at /dashboard. vite.config.ts proxies the API
        prefixes and leaves /dashboard to the SPA — see the comment there for
        the collision Phase 4 hit for real.

        Login sits OUTSIDE RequireAuth (it is the place you land when you have
        no session) and everything else inside it.
      */}
      <Route path="/dashboard/login" element={<LoginPage />} />
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <DashboardLayout />
          </RequireAuth>
        }
      >
        <Route index element={<CommunitiesPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="co-builder" element={<CoBuilderPage />} />
        <Route path="c/:communityId" element={<CommunityOverviewPage />} />
        <Route path="c/:communityId/tiers" element={<TiersPage />} />
        <Route path="c/:communityId/channels" element={<ChannelsPage />} />
        <Route path="c/:communityId/members" element={<MembersPage />} />
        <Route path="c/:communityId/activity" element={<ActivityPage />} />
        <Route path="c/:communityId/streaming" element={<EventsPage />} />
        {/* An unknown /dashboard/... path goes to the dashboard's own home, not
            to the public checkout 404 the catch-all below serves. */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Route>

      {/*
        Task 6: personal accounts — a separate session from the creator
        dashboard above (see user/apiClient.ts's own docstring). All public,
        rendered OUTSIDE the shell below: no session, so no navigation.
      */}
      <Route path="/signup" element={<UserSignupPage />} />
      <Route path="/masuk" element={<UserLoginPage />} />
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

        Static, single-segment paths — registered here, BEFORE /:handleParam
        below, for the same reason /signup and /masuk are: see that route's
        own comment on why this ordering is defensive rather than load-bearing.
      */}
      <Route element={<AppShell />}>
        <Route path="/beranda" element={<BerandaPage />} />
        <Route path="/jelajah" element={<JelajahPage />} />
        <Route path="/siaran" element={<SiaranPage />} />
        <Route path="/pengaturan" element={<SettingsPage />} />
      </Route>

      {/*
        Task 5: reachable by tapping either count on ProfilePage. Both are
        TWO-segment paths ("/:handleParam/pengikut",
        "/:handleParam/mengikuti"), strictly more specific than the bare
        one-segment "/:handleParam" below — React Router ranks a route with
        more matched segments above a shorter one regardless of declaration
        order (same reasoning as /c/:slug/status/:subscriptionId above), so
        neither can ever be shadowed by the profile route. Registered before
        it anyway, for the same "defensive, not load-bearing" reason
        /:handleParam's own comment gives.
      */}
      <Route path="/:handleParam/pengikut" element={<FollowListPage direction="followers" />} />
      <Route path="/:handleParam/mengikuti" element={<FollowListPage direction="following" />} />

      {/*
        THE PROFILE ROUTE — path="/:handleParam", NOT path="/@:handle".
        React Router cannot match a literal glued to a parameter inside one
        path segment, so "/@:handle" would never match "/@wildan" at all.
        ProfilePage itself renders the 404 page unless the param starts
        with "@", and strips it before calling the API.

        Registered LAST, immediately before the catch-all: a single-segment
        dynamic route would otherwise be free to shadow /signup, /masuk, and
        every other one-segment path above. React Router actually ranks
        static segments above dynamic ones regardless of declaration order
        (same note the /c/:slug block above makes), so this ordering is
        defensive rather than load-bearing — but it is exactly the ordering
        whose absence would silently break /masuk, so it is kept here
        anyway and covered by its own routing test.
      */}
      <Route path="/:handleParam" element={<ProfilePage />} />

      {/* Rendered IN PLACE, never redirected: the URL the visitor typed has to stay
          in the address bar or the message cannot be acted on. This used to send
          every unknown path to /c/tidak-ada, which reported that a specific
          community was missing when none had been named. */}
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
 */
export default function App() {
  useEffect(() => {
    void repairSplitSession();
  }, []);

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
