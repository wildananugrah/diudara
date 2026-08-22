import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import StreamPlayer, { type AttachHls } from "./StreamPlayer";
import { describeRequestFailure } from "./errorCopy";
import { listStreams, type StreamView, type WatchTokenResult } from "./apiClient";

/**
 * `/siaran` — who is live, and a lock where a stranger cannot watch (design
 * spec §8, member-UI spec §5's rule applied to video rather than a photo).
 *
 * **`locked` IS THE SERVER'S ANSWER, and this component never re-derives
 * it.** `GET /streams` returns `hlsPlaybackPath` ABSENT — not `null` — on a
 * row this viewer is locked out of (`StreamView`'s own docstring in
 * `apiClient.ts`), so there is nothing here that COULD compute a playback
 * path for a locked row even by accident: `stream.locked` alone decides
 * which branch below runs, and the locked branch never reads
 * `hlsPlaybackPath` at all. A paywall enforced in React is not a paywall —
 * member-UI spec §5.1.
 *
 * **`attachHls`/`mintToken` are threaded straight through to `StreamPlayer`
 * for every row**, purely so a test can inject a fake without touching real
 * `hls.js` or a real network call — the same DI shape `WatchPage`'s
 * `attachPlayer` prop uses. Production renders always omit both, which is
 * how `<Route path="/siaran" element={<SiaranPage />} />` in `App.tsx`
 * already calls this component.
 *
 * **Creator controls — a title, the *Khusus anggota* checkbox, *Mulai
 * siaran* (design spec §8's second half) — are DELIBERATELY NOT built
 * here.** This task's own brief scopes Siaran to "who is live, and a lock
 * where a stranger cannot watch" and lists exactly three files to touch,
 * none of them a composer; no task in this phase's dispatch plan owns a
 * `POST /streams` form despite the route existing since Task 3. Recorded
 * here rather than silently — a future task will need to add it, and this
 * page's own history should say why it did not arrive with the rest of
 * Siaran.
 */
export default function SiaranPage({
  attachHls,
  mintToken,
}: {
  attachHls?: AttachHls;
  mintToken?: (streamId: string) => Promise<WatchTokenResult>;
} = {}) {
  const [streams, setStreams] = useState<StreamView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const result = await listStreams();
        if (cancelled) return;
        setStreams(result.streams);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(describeRequestFailure(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="user-page siaran-page" data-testid="siaran">
      <h1>Siaran</h1>

      {/* `role="alert"` matches every other top-level request-failure element under src/user (PostFeed, FollowButton, ...). */}
      {error !== null ? (
        <p className="feed-error" role="alert">
          {error}
        </p>
      ) : null}

      {/* Honest, not a spinner — the same reasoning `BerandaPage.test.tsx` and this page's own predecessor gave, applied to the same fetch-then-render shape every other list on this app already uses. */}
      {!loading && error === null && streams.length === 0 ? (
        <p>Belum ada siaran langsung.</p>
      ) : null}

      {streams.map((stream) => (
        <article key={stream.id} className="stream-card" data-testid="stream-card">
          <header className="stream-card-header">
            <h2>{stream.title}</h2>
            <Link to={`/@${stream.owner.handle}`} className="stream-card-owner">
              {stream.owner.displayName} · @{stream.owner.handle}
            </Link>
          </header>

          {stream.locked ? (
            // The lock — the conversion surface (member-UI spec §5; design
            // spec §8: "the same shape as a locked post, for the same
            // reason"). Carries ONLY a link to the owner's profile, where
            // the offer already lives — no media element, no id, and
            // nothing derived from `hlsPlaybackPath` (which the API never
            // even sends on this row) for a future edit to accidentally
            // wire a playback URL onto.
            <Link
              to={`/@${stream.owner.handle}`}
              className="stream-lock"
              data-testid="stream-lock"
            >
              Jadi anggota untuk menonton
            </Link>
          ) : (
            <StreamPlayer stream={stream} attachHls={attachHls} mintToken={mintToken} />
          )}
        </article>
      ))}
    </main>
  );
}
