import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { Link } from "react-router-dom";
import StreamPlayer, { type AttachHls } from "./StreamPlayer";
import { describeRequestFailure, describeStreamStartFailure } from "./errorCopy";
import {
  endOwnStream,
  isOwnHandle,
  isUserSignedIn,
  listStreams,
  startOwnStream,
  subscribeToUserAuth,
  type StreamView,
  type WatchTokenResult,
} from "./apiClient";
import { publishToWhip, type PublishHandle } from "./whip-publisher";

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
 * siaran* — are `StreamComposer` below** (design spec §8's second half;
 * split from this component's own first half, "who is live and a lock,"
 * which is Task 7). Signed-in only: `POST /streams` requires a session, and
 * `useSyncExternalStore(subscribeToUserAuth, isUserSignedIn, ...)` is the
 * same gate `BerandaPage` already uses to show `PostComposer` only to a
 * signed-in visitor, for the identical reason — there is nothing for a
 * signed-out one to do here but collect `SESSION_EXPIRED_MESSAGE`.
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
  const signedIn = useSyncExternalStore(subscribeToUserAuth, isUserSignedIn, () => false);

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

  /**
   * **The signed-in creator's OWN live row, out of the listing this page
   * already fetched — I2's fix, and the whole of its data half.**
   *
   * `GET /streams` returns every `live` row, and `user_stream_one_live`
   * guarantees a person holds at most one of them, so this `find` cannot be
   * ambiguous. `isOwnHandle` is the ONE handle comparison this app makes
   * (`apiClient.ts`: case-insensitive, both sides normalised, read from the
   * "who am I?" cache rather than from `isUserSignedIn()`) — reused, never
   * re-implemented, exactly as `ProfilePage` and `PostCard` reuse it.
   *
   * `null` for a signed-out visitor (no session handle to compare against),
   * for a creator who is not live, and while the first fetch is still in
   * flight.
   */
  const ownLiveStream = streams.find((stream) => isOwnHandle(stream.owner.handle)) ?? null;

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

      {/* Below the list, per design spec §8's own words. Signed-in only —
          see this component's own docstring. `ownLiveStream` is I2's fix:
          the listing this page already fetched is where a creator's own
          live row lives, so it is also what makes *Akhiri siaran* reachable
          after a reload. See `StreamComposer`'s own docstring. */}
      {signedIn ? <StreamComposer ownLiveStream={ownLiveStream} /> : null}
    </main>
  );
}

/**
 * **What the live panel actually needs to exist — deliberately NOT
 * `StartedStream`.**
 *
 * I2. `StartedStream` is `POST /streams`'s response, and three of its fields
 * (`streamKey`, `rtmpUrl`, `whipUrl`) exist ONLY there: `GET /streams` never
 * carries a publish credential, so a panel typed as `StartedStream` can only
 * ever be built by the one browser session that pressed *Mulai siaran*. That
 * is precisely how *Akhiri siaran* came to be unreachable after a reload.
 *
 * So the panel is typed by what it RENDERS instead — an id to `DELETE`, a
 * title to show, and OBS details when, and only when, this session happens
 * to hold them.
 */
interface LiveBroadcast {
  /** The row id `DELETE /streams/:id` names. Never the stream key — see `authoriseUserReadByStreamId` on the API side for why the two are not interchangeable. */
  id: string;
  title: string;
  /**
   * `null` for a broadcast REHYDRATED from `GET /streams`, which has no
   * publish credential in it at all. Non-null only in the session that
   * started the stream, and cleared with the rest of `liveStream` the
   * instant *Akhiri siaran* runs — see the stream key's lifetime, above.
   */
  obs: { rtmpUrl: string; streamKey: string } | null;
}

/**
 * The creator's own controls (design spec §8's second half; task brief):
 * a title, *Khusus anggota*, and *Mulai siaran* — then, once live, *Akhiri
 * siaran* and a collapsed *Pakai OBS* block.
 *
 * ============================ THE STREAM KEY'S LIFETIME ============================
 * `startOwnStream`'s response is the ONLY place `streamKey` ever reaches
 * this browser (`StartedStream`'s own docstring in `apiClient.ts`) — it is
 * held in `liveStream`, THIS COMPONENT'S OWN local state, for exactly as
 * long as the broadcast it belongs to: never logged, never put in a URL
 * (`whipUrl`/`rtmpUrl` are separate fields the server derives from it, and
 * neither is ever built by concatenating the key onto anything here), and
 * `endStream` below sets `liveStream` back to `null` in every case —
 * success AND failure of the `DELETE` itself — so *Akhiri siaran* always
 * unmounts the OBS block and takes the key out of the DOM with it, whether
 * or not the network call that ended the row server-side actually
 * succeeded. See `SiaranPage.test.tsx`'s own test for what this promises,
 * and `DELETE /streams/:id`'s own docstring in `apiClient.ts` for why
 * ending locally even on a failed request is the right call: that route
 * works even on a box with no streaming provider configured, specifically
 * so a creator can never be left unable to end their own stream.
 * =======================================================================
 *
 * ==================== BROWSER PUBLISH, WITH OBS ALWAYS AS A FALLBACK ====================
 * Design spec §7: "The browser publishes over WHIP." The moment `POST
 * /streams` succeeds, `goLiveOverWhip` attempts exactly that —
 * `navigator.mediaDevices.getUserMedia` for a default camera+mic, then
 * `publishToWhip` (moved into this same directory from
 * `dashboard/whip-publisher.ts` by this task, since Phase 8 deletes that
 * directory — see that module's own docstring, unchanged by the move).
 *
 * Neither an unsupported browser, a denied/missing camera, nor a failed WHIP
 * negotiation takes the stream down: the row is already `live` server-side
 * the moment `startOwnStream` resolves, and the RTMP URL/key are shown
 * regardless, so a creator whose browser cannot publish can still go live
 * from OBS without starting over. `browserPublishNotice` says so in one
 * Bahasa sentence rather than `EventsPage.tsx`'s own five-way
 * `DEVICE_STATUS_MESSAGE` table — this screen's own copy list (task brief)
 * names nothing beyond `Mulai siaran`/`Akhiri siaran`/`Khusus
 * anggota`/`Pakai OBS`/`Judul`, so the camera/mic picker, the local preview,
 * and the "don't close this tab" unload warning all stay exactly where they
 * are, in the directory this phase does not touch.
 *
 * Nothing here reads `.message` off a caught error (`no-raw-server-errors`
 * guard, scoped to `src/user/`) — a failed `getUserMedia`/`publishToWhip`
 * call is reported with this component's OWN Bahasa sentence, never the
 * browser's or `WhipNegotiationError`'s own text.
 * =======================================================================
 *
 * ==================== AKHIRI SIARAN SURVIVES A RELOAD (I2) ====================
 * `liveStream` used to be local state and nothing rehydrated it, which made
 * `DELETE /streams/:id` — a route built and tested "specifically so a
 * creator can never be left unable to end their own stream" — UNREACHABLE in
 * exactly the case it was written for. The route the review walked: a
 * browser publish that never starts (no `mediaDevices`, a denied camera, a
 * WHIP negotiation that fails) leaves the row `live` server-side with NO
 * publisher ever connected, so MediaMTX never fires `offline`, so nothing
 * ends the row until `SweepStaleUserStreams` at twelve hours. Reload, and
 * there was no *Akhiri siaran* anywhere in the app; the next *Mulai siaran*
 * 409'd against `user_stream_one_live` for the rest of those twelve hours.
 *
 * `ownLiveStream` closes it with the data the page ALREADY HAS: the
 * creator's own `live` row is in `GET /streams` like everybody else's, and
 * `SiaranPage` picks it out with `isOwnHandle`. Whenever this component
 * holds no live broadcast of its own and that row is present, it adopts it —
 * so the control appears however the creator got here, not only in the
 * browser session that pressed *Mulai siaran*.
 *
 * **A REHYDRATED BROADCAST HAS NO OBS BLOCK, and that is not a gap to fill
 * later.** `streamKey`/`rtmpUrl` come back from `POST /streams` and from
 * nowhere else — `GET /streams` deliberately never carries a publish
 * credential (`StreamView`'s own docstring) — so `obs` is `null` on every
 * rehydrated row and the `<details>` simply does not render. Widening the
 * listing to carry the key so this panel could look the same would hand a
 * publish credential to every viewer of every stream, which is the one thing
 * this whole phase is arranged to prevent.
 *
 * **`endedIdsRef` is what stops the adoption looping.** The listing is not
 * refetched after *Akhiri siaran*, so the row this component rehydrated from
 * is still in `streams` when the panel closes; without a memory of what was
 * ended, the effect would re-adopt it on the very next render and pin the
 * creator in a panel they just dismissed. Ids are recorded rather than a
 * single boolean because a creator may legitimately end one stream and start
 * another in the same session, and the new one carries a different id.
 * =======================================================================
 */
function StreamComposer({ ownLiveStream }: { ownLiveStream: StreamView | null }) {
  const [title, setTitle] = useState("");
  const [membersOnly, setMembersOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [startFailure, setStartFailure] = useState<string | null>(null);
  const [liveStream, setLiveStream] = useState<LiveBroadcast | null>(null);
  const [ending, setEnding] = useState(false);
  const [browserPublishNotice, setBrowserPublishNotice] = useState<string | null>(null);

  /**
   * Every stream id *Akhiri siaran* has already been pressed for in this
   * session — see this component's own docstring on why a stale listing
   * makes this necessary. A ref, not state: nothing renders from it, and a
   * write to it must not schedule a render of its own.
   */
  const endedIdsRef = useRef<Set<string>>(new Set());

  /** The live WHIP publish, if the browser managed to start one. `null` whenever there is none to close. */
  const handleRef = useRef<PublishHandle | null>(null);
  /**
   * Set the instant this component unmounts — checked before ANY async step
   * (`goLiveOverWhip`) touches state, the same guard `EventsPage.tsx`'s own
   * `cancelledRef` uses and for the identical reason: a promise that settles
   * after the component is gone must close what it opened rather than call
   * a setter nobody will ever read.
   */
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      // Unmounting mid-broadcast (navigating away) must not leave a camera
      // light on or a publish running with nothing left able to stop it —
      // the row itself stays `live` server-side either way; only the
      // BROWSER'S OWN publish is closed here.
      handleRef.current?.close();
      handleRef.current = null;
    };
  }, []);

  /**
   * **THE REHYDRATION — I2's fix in four lines.** Adopts the creator's own
   * `live` row from the listing whenever this component is not already
   * holding one, so *Akhiri siaran* is on screen for anybody who holds a
   * live row, however they got here. See this component's own docstring for
   * the failure this closes and for why `endedIdsRef` is consulted.
   *
   * No fetch of its own: `SiaranPage` already asked `GET /streams` and this
   * reads the answer it got. Nothing here can start a stream, and nothing
   * here can end one — adopting a row only makes the control that ends it
   * reachable.
   */
  useEffect(() => {
    if (ownLiveStream === null) return;
    if (liveStream !== null) return;
    if (endedIdsRef.current.has(ownLiveStream.id)) return;
    setLiveStream({ id: ownLiveStream.id, title: ownLiveStream.title, obs: null });
  }, [ownLiveStream, liveStream]);

  const canSubmit = title.trim().length > 0 && !submitting;

  /** Attempts the browser-WHIP half of going live. Never throws — every failure is absorbed into `browserPublishNotice`. */
  async function goLiveOverWhip(whipUrl: string): Promise<void> {
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) {
      if (!cancelledRef.current) {
        setBrowserPublishNotice(
          "Siaran dari browser tidak didukung di peramban ini — gunakan detail OBS di bawah."
        );
      }
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      if (!cancelledRef.current) {
        setBrowserPublishNotice(
          "Tidak dapat mengakses kamera/mikrofon untuk siaran dari browser — gunakan detail OBS di bawah."
        );
      }
      return;
    }

    if (cancelledRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    try {
      const handle = await publishToWhip({ whipUrl, stream });
      if (cancelledRef.current) {
        // Nothing will ever call `close()` on this handle otherwise — see
        // `cancelledRef`'s own docstring.
        handle.close();
        return;
      }
      handleRef.current = handle;
    } catch {
      if (!cancelledRef.current) {
        setBrowserPublishNotice("Gagal memulai siaran dari browser — gunakan detail OBS di bawah.");
      }
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    // Belt and braces with `disabled` below — a form can also be submitted
    // by Enter in some browsers.
    if (!canSubmit) return;

    setSubmitting(true);
    setStartFailure(null);
    setBrowserPublishNotice(null);
    try {
      const started = await startOwnStream({
        title: title.trim(),
        // Omitted entirely when unchecked — see `startOwnStream`'s own
        // docstring on why this never sends a literal `"public"`.
        visibility: membersOnly ? "members" : undefined,
      });
      setLiveStream({
        id: started.id,
        title: started.title,
        obs: { rtmpUrl: started.rtmpUrl, streamKey: started.streamKey },
      });
      setTitle("");
      setMembersOnly(false);
      void goLiveOverWhip(started.whipUrl);
    } catch (err: unknown) {
      // `describeStreamStartFailure` already special-cases the 503 this
      // route answers when no streaming provider is configured, rather
      // than the generic "coba lagi sebentar lagi" — see its own docstring.
      setStartFailure(describeStreamStartFailure(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function endStream(): Promise<void> {
    if (liveStream === null) return;
    setEnding(true);
    // Closes the BROWSER'S OWN publish first, unconditionally — whether or
    // not the DELETE below succeeds, this browser stops sending video the
    // instant `close()` returns (`PublishHandle.close()`'s own contract).
    handleRef.current?.close();
    handleRef.current = null;
    try {
      await endOwnStream(liveStream.id);
    } catch {
      // `DELETE /streams/:id` works even with no provider configured
      // (`endOwnStream`'s own docstring) — a failure here is a network
      // problem, not a reason to leave the creator's OWN screen still
      // claiming they are live when their browser has already stopped
      // sending. See this component's own docstring on the stream key's
      // lifetime for why `liveStream` is cleared below regardless.
    } finally {
      // Recorded BEFORE the panel closes, so the rehydration effect above
      // cannot re-adopt this same row out of a listing that has not been
      // refetched — see this component's own docstring.
      endedIdsRef.current.add(liveStream.id);
      setLiveStream(null);
      setBrowserPublishNotice(null);
      setEnding(false);
    }
  }

  if (liveStream !== null) {
    return (
      <div className="stream-composer stream-composer-live" data-testid="stream-composer">
        <p>
          Anda sedang live: <strong>{liveStream.title}</strong>
        </p>

        {browserPublishNotice !== null ? (
          <p className="feed-error" role="alert">
            {browserPublishNotice}
          </p>
        ) : null}

        {/* Collapsed by default — design spec §7: "a collapsed block for a
            creator on a desktop with OBS." Absent entirely on a REHYDRATED
            broadcast: `GET /streams` never carries a publish credential, so
            there is nothing to put here. See `LiveBroadcast.obs`. */}
        {liveStream.obs !== null ? (
          <details className="stream-obs-details" data-testid="stream-obs-details">
            <summary>Pakai OBS</summary>
            <p>
              URL RTMP: <code>{liveStream.obs.rtmpUrl}</code>
            </p>
            <p>
              Stream key: <code>{liveStream.obs.streamKey}</code>
            </p>
          </details>
        ) : null}

        <button type="button" className="button-danger" onClick={() => void endStream()} disabled={ending}>
          {ending ? "Mengakhiri..." : "Akhiri siaran"}
        </button>
      </div>
    );
  }

  return (
    <form className="stream-composer" data-testid="stream-composer" onSubmit={handleSubmit}>
      <label>
        Judul
        <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>

      <label>
        <input
          type="checkbox"
          checked={membersOnly}
          onChange={(event) => setMembersOnly(event.target.checked)}
        />
        Khusus anggota
      </label>

      <button type="submit" className="button-primary" disabled={!canSubmit}>
        Mulai siaran
      </button>

      {startFailure !== null ? (
        <p className="feed-error" role="alert">
          {startFailure}
        </p>
      ) : null}
    </form>
  );
}
