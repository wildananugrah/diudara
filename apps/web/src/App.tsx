import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import CheckoutPage from "./pages/CheckoutPage";
import StatusPage from "./pages/StatusPage";
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

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* react-router v7 ranks routes by specificity regardless of
            declaration order, so this 3-segment route always wins over
            /c/:slug for a URL like /c/kelas-budi/status/sub-1 — listed first
            here only for readability, not because order is load-bearing. */}
        <Route path="/c/:slug/status/:subscriptionId" element={<StatusPage />} />
        <Route path="/c/:slug" element={<CheckoutPage />} />

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
          <Route path="c/:communityId" element={<CommunityOverviewPage />} />
          <Route path="c/:communityId/tiers" element={<TiersPage />} />
          <Route path="c/:communityId/channels" element={<ChannelsPage />} />
          <Route path="c/:communityId/members" element={<MembersPage />} />
          <Route path="c/:communityId/activity" element={<ActivityPage />} />
          {/* An unknown /dashboard/... path goes to the dashboard's own home, not
              to the public checkout 404 the catch-all below serves. */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>

        <Route path="*" element={<Navigate to="/c/tidak-ada" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
