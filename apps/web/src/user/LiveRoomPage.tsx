import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import NotFoundPage from "../pages/NotFoundPage";
import { listStreams, type StreamView } from "./apiClient";
import { describeRequestFailure } from "./errorCopy";
import StreamPlayer from "./StreamPlayer";

type LoadState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "error"; message: string }
  | { status: "ready"; stream: StreamView };

/**
 * `/siaran/:streamId` — the focused way to watch a broadcast.
 *
 * **A BROADCAST, not a call.** The programme's Phase 7 required a decision
 * before this page could exist, and the decision was a broadcast studio: one
 * person on camera, many watching. The mockup's participant strip is
 * therefore not here and is not deferred — it is the conference feature, and
 * there is nobody for it to show.
 *
 * **The profile keeps its own player.** This page does not replace it: a
 * visitor who lands on a broadcaster's profile while they are live should see
 * the broadcast there rather than be bounced. Both mount the SAME
 * `StreamPlayer` with the same token minting, so there is no second playback
 * path to keep in sync.
 *
 * **No new endpoint.** `GET /streams` already returns every live stream with
 * its `locked` flag; this reads the one it needs by id. A `GET /streams/:id`
 * would be a second read path answering what the first already answers.
 */
export default function LiveRoomPage() {
  const { streamId } = useParams<{ streamId: string }>();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (streamId === undefined) return;
    let cancelled = false;
    setLoad({ status: "loading" });
    listStreams()
      .then((result) => {
        if (cancelled) return;
        const stream = result.streams.find((candidate) => candidate.id === streamId);
        // A stream that has ended leaves the list, so "not live" and "never
        // existed" arrive here identically — and both are absence to a viewer.
        setLoad(
          stream === undefined ? { status: "not-found" } : { status: "ready", stream }
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ status: "error", message: describeRequestFailure(error) });
      });
    return () => {
      cancelled = true;
    };
    // Deliberately NOT re-running on an interval. A stream ending while
    // somebody is watching must not yank the page out from under them — the
    // player handles its own end-of-stream, and a viewer staring at a stopped
    // video understands it better than a sudden 404.
  }, [streamId]);

  if (load.status === "loading") {
    return (
      <main className="live-room">
        <p className="live-room-status">Memuat...</p>
      </main>
    );
  }

  if (load.status === "not-found") return <NotFoundPage />;

  if (load.status === "error") {
    return (
      <main className="live-room">
        <p className="live-room-status" role="alert">
          {load.message}
        </p>
      </main>
    );
  }

  const { stream } = load;

  return (
    <main className="live-room" data-testid="live-room">
      <header className="live-room-bar">
        <Link to="/siaran" className="live-room-exit">
          Keluar
        </Link>
        {/* `.live-badge` ALREADY EXISTS in styles.css, with its own `.dot`.
            A `.live-room-badge` of my own was 4.24:1 against --merah-senja and
            contrast.test.ts named it; this one is the shipped pairing that
            already passes, so reusing it fixes the contrast and removes a
            second thing to keep in visual sync. */}
        <span className="live-badge">
          <span className="dot" aria-hidden />
          LIVE
        </span>
        <span className="live-room-title">{stream.title}</span>
        <Link to={`/@${stream.owner.handle}`} className="live-room-owner">
          {stream.owner.displayName} · @{stream.owner.handle}
        </Link>
      </header>

      <div className="live-room-stage">
        {stream.locked ? (
          // The SAME two branches `ProfilePage` already has. A non-member is
          // never handed a player that would fail to attach — no token is
          // minted and no HLS attach begins, which is the reason `SiaranPage`
          // carries no player at all.
          <div className="stream-lock" data-testid="live-room-lock">
            <p className="stream-lock-copy">Siaran ini khusus anggota.</p>
            <Link to={`/@${stream.owner.handle}`} className="stream-lock-cta">
              Jadi anggota untuk menonton
            </Link>
          </div>
        ) : (
          <StreamPlayer stream={stream} />
        )}
      </div>

      {/*
        THE CHAT COLUMN IS NOT HERE, and its space is left empty rather than
        filled with a disabled input or a "coming soon" panel. Live chat needs
        the realtime layer Phase 8 owns, and a control for an action that
        cannot happen is the thing Phase 1 cut the tab bar to avoid.
      */}
    </main>
  );
}
