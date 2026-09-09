/**
 * The reference's page frame: 20px of padding and a 1180px cap. Its version
 * is desktop-only; the max-width here is a cap rather than a width, so below
 * 768px it simply fills the column.
 */
export default function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="page-container">{children}</div>;
}
