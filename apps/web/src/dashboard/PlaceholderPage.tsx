import { useParams } from "react-router-dom";

/**
 * SCAFFOLDING FOR TASK 5 ONLY.
 *
 * The shell (auth, routing, layout) is committed on its own so the session
 * behaviour is reviewable without the screens on top of it. Every route this fills
 * is replaced by a real page in Tasks 6 and 7; this file is deleted then.
 *
 * It exists rather than the routes being left out, because the shell's headline
 * risk — "does a deep dashboard URL serve the SPA or raw JSON?" — can only be
 * verified against a deep URL that actually resolves.
 */
export default function PlaceholderPage({ title }: { title: string }) {
  const { communityId } = useParams<{ communityId: string }>();
  return (
    <section>
      <h1>{title}</h1>
      <p className="muted">
        Layar ini dipasang pada langkah berikutnya.
        {communityId !== undefined ? ` Komunitas: ${communityId}` : ""}
      </p>
    </section>
  );
}
