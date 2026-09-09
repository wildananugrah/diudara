/**
 * The reference's page frame: 20px of padding and a 1180px cap. Its version
 * is desktop-only; the max-width here is a cap rather than a width, so below
 * 768px it simply fills the column.
 *
 * Unused as of the whole-branch review fix pass (2026-09-09): none of the six
 * `.user-page` pages render it any more — a 1180px cap can never bind inside
 * `.user-page`'s own 36rem-wide parent, so it was only compounding padding.
 * The app's reading column is `.user-page` at 36rem; this component is kept
 * for the wide community pages a later phase is expected to add. Whether the
 * app should adopt this wider 1180px frame instead of the 36rem column is a
 * design question for the repo owner, not settled by that fix pass.
 */
export default function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="page-container">{children}</div>;
}
