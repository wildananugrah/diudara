import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import CheckoutPage from "./pages/CheckoutPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/c/:slug" element={<CheckoutPage />} />
        <Route path="*" element={<Navigate to="/c/tidak-ada" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
