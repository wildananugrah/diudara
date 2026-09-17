import Sidebar from "./Sidebar";
import FloatingChat from "../chat/FloatingChat";

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--surface)" }}>
      <Sidebar />
      <main style={{ flex: 1, minWidth: 0, background: "var(--surface)" }}>{children}</main>
      <FloatingChat />
    </div>
  );
}
