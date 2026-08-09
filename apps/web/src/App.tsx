import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import CheckoutPage from "./pages/CheckoutPage";
import StatusPage from "./pages/StatusPage";

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
        <Route path="*" element={<Navigate to="/c/tidak-ada" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
