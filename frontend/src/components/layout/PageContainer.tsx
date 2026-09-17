export default function PageContainer({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 20, maxWidth: 1180, margin: "0 auto" }}>
      {children}
    </div>
  );
}
