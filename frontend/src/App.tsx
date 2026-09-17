import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import AppShell from "./components/layout/AppShell";
import Discover from "./pages/Discover";
import CommunityHome from "./pages/CommunityHome";
import DiscussionDetail from "./pages/DiscussionDetail";
import EventDetail from "./pages/EventDetail";
import AnnouncementDetail from "./pages/AnnouncementDetail";
import LiveRoomPage from "./pages/LiveRoomPage";
import Checkout from "./pages/Checkout";
import CreatorDashboard from "./pages/CreatorDashboard";
import PulseOnboarding from "./pages/PulseOnboarding";
import Login from "./pages/Login";
import Register from "./pages/Register";
import { AuthProvider, RequireAuth } from "./lib/auth";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public — no session required */}
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          {/* Full-bleed pages without the sidebar */}
          <Route path="/live/:id" element={<RequireAuth><LiveRoomPage /></RequireAuth>} />
          <Route path="/checkout/:id" element={<RequireAuth><Checkout /></RequireAuth>} />
          <Route path="/onboarding" element={<RequireAuth><PulseOnboarding /></RequireAuth>} />

          {/* Pages inside the app shell (with sidebar nav) */}
          <Route
            path="/*"
            element={
              <RequireAuth>
                <AppShell>
                  <Routes>
                    <Route path="/discover" element={<Discover />} />
                    <Route path="/community/:id" element={<CommunityHome />} />
                    <Route path="/community/:id/discussion/:postId" element={<DiscussionDetail />} />
                    <Route path="/community/:id/event/:eventId" element={<EventDetail />} />
                    <Route path="/community/:id/announcement/:announcementId" element={<AnnouncementDetail />} />
                    <Route path="/creator/dashboard/:id" element={<CreatorDashboard />} />
                    <Route path="/creator/dashboard" element={<Navigate to="/discover" replace />} />
                    <Route path="*" element={<Navigate to="/discover" replace />} />
                  </Routes>
                </AppShell>
              </RequireAuth>
            }
          />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
