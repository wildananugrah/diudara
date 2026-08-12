import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, DashboardApiError } from "../apiClient";
import { formatDateTime, liveSessionStatusExplanation, liveSessionStatusLabel } from "../format";
import { CommunityHeader, CopyableLink, EmptyState, ErrorPanel, Field, NotFoundPanel } from "../ui";
import { useCommunity } from "../useCommunity";
import { useLoad } from "../useLoad";
import { publishToWhip, type PublishHandle } from "../whip-publisher";
import type { CreatedLiveSession, LiveSession, StreamingStatus } from "../types";

/**
 * The creator's "Siaran langsung" screen (Task 7): schedule a live session,
 * see every session ever scheduled for this community and its status, and —
 * once a session exists — publish to it either from the browser (Task 3) or
 * from an encoder like OBS, with enough instruction for someone who has
 * never configured either.
 *
 * ============================ THE STREAM KEY IS A SECRET ============================
 * Same treatment as any credential (see `types.ts`'s `LiveSession` docstring):
 * never logged, never put in a URL, and never assumed safe to show just
 * because a community id is in the route — the API 404s the WHOLE fetch for
 * a community this creator does not own (see `useCommunity`), so nothing
 * below ever has a stream key to accidentally render for a stranger.
 *
 * Two places a key appears, both deliberate:
 *  1. `justCreated` — shown IMMEDIATELY and in full, because that is the one
 *     moment a creator is actually about to go live or paste it into OBS.
 *  2. Each row's own "Siarkan" toggle — collapsed by default, so a screen
 *     with ten past sessions does not print ten secrets at once, but a
 *     creator who wants to go live from a session scheduled yesterday (or
 *     lost their OBS settings) can still reach it. This is exactly why Task 2
 *     rebuilds `rtmpUrl`/`whipUrl` on the LISTING endpoint too, not only on
 *     creation — see `types.ts`'s `LiveSession` docstring.
 *
 * `justCreated` is LOCAL STATE, and React Router reuses this exact component
 * instance across a route-param change (switching communities does not
 * remount it) — so it is reset by the effect below the moment `communityId`
 * changes, rather than surviving into a screen about a different community's
 * session. See EventsPage.test.tsx's "does not carry a just-created stream
 * key over" test, which is what pins this.
 * =======================================================================
 *
 * ==================== WHY EACH BROWSER-PUBLISHING FAILURE HAS ITS OWN MESSAGE ====================
 * A creator meeting this screen has never heard of WebRTC, SDP, or ICE. Five
 * situations each get their own Indonesian wording, in `BrowserPublishSection`
 * below:
 *  - permission denied -> say how to grant it (the browser's own site-settings UI)
 *  - no camera/microphone present -> say so BEFORE the "go live" button ever
 *    appears (see `DEVICE_STATUS_MESSAGE` and where the button is rendered)
 *  - the session is already `live` because OBS is publishing -> the button is
 *    disabled AND the reason is spelled out, not just greyed out silently
 *  - the session is already `ended` -> browser publishing is not offered at
 *    all; the creator is told to schedule a new one instead
 *  - a failed WHIP negotiation -> `whip-publisher.ts`'s own `WhipNegotiationError`
 *    already names the likely cause (a network blocking UDP) and points at
 *    OBS as the alternative; this screen just renders `error.message`
 *
 * `getUserMedia` needs a SECURE CONTEXT — it works from `https://` and from
 * `http://localhost` (which browsers exempt) but nowhere else. Opening this
 * dashboard from another device against a laptop's LAN address over plain
 * HTTP fails here with the exact same `NotAllowedError` a real permission
 * denial produces, which is a confusing thing to meet cold while testing —
 * see `classifyGetUserMediaError`'s own comment.
 *
 * CLOSING THE TAB ENDS THE SESSION PERMANENTLY, a known, deliberately-deferred
 * limitation carried over from the RTMP path (see CONTRIBUTING.md's "Deferred,
 * on purpose: an OBS reconnect currently kills the session") — and a browser
 * tab is far easier to close by accident than OBS is to quit. `beforeunload`
 * is wired up for exactly the window this is live, in `BrowserPublishSection`.
 * =======================================================================
 */
export default function EventsPage() {
  const { communityId } = useParams<{ communityId: string }>();
  const [communityLoad] = useCommunity(communityId);
  const [statusLoad] = useLoad(() => apiFetch<StreamingStatus>("/streaming/status"), []);
  const [sessionsLoad, sessionsHandle] = useLoad(
    () => apiFetch<LiveSession[]>(`/communities/${communityId}/events`),
    [communityId]
  );

  const [justCreated, setJustCreated] = useState<CreatedLiveSession | null>(null);

  // See this file's own docstring: `communityId` changing means the creator
  // switched communities WITHOUT this component remounting. Nothing about a
  // previous community's stream key may survive that.
  useEffect(() => {
    setJustCreated(null);
  }, [communityId]);

  if (communityLoad.kind === "loading") return <p className="muted">Memuat...</p>;
  if (communityLoad.kind === "error") return <ErrorPanel message={communityLoad.message} />;
  if (communityLoad.data === null) return <NotFoundPanel />;

  const streamingEnabled = statusLoad.kind === "ready" && statusLoad.data.enabled;

  return (
    <section>
      <CommunityHeader community={communityLoad.data} />
      <h2>Siaran langsung</h2>

      {sessionsLoad.kind === "loading" ? <p className="muted">Memuat sesi...</p> : null}
      {sessionsLoad.kind === "error" ? (
        <ErrorPanel message={sessionsLoad.message} onRetry={sessionsHandle.reload} />
      ) : null}

      {sessionsLoad.kind === "ready" ? (
        <div className="section">
          {sessionsLoad.data.length === 0 ? (
            <EmptyState
              title="Belum ada sesi siaran"
              action="Jadwalkan sesi pertama Anda di bawah ini. Setelah dibuat, Anda bisa langsung menyiarkan dari browser, atau memasukkan URL RTMP dan stream key ke OBS."
            />
          ) : (
            <SessionTable sessions={sessionsLoad.data} />
          )}
        </div>
      ) : null}

      {justCreated !== null ? (
        <div className="section">
          <NewSessionPanel session={justCreated} />
        </div>
      ) : null}

      {statusLoad.kind === "loading" ? <p className="muted">Memuat...</p> : null}

      {streamingEnabled && sessionsLoad.kind === "ready" ? (
        <ScheduleSessionForm
          communityId={communityId!}
          onCreated={(created, scheduledAtIso) => {
            setJustCreated(created);
            sessionsHandle.update([
              {
                id: created.id,
                communityId: communityId!,
                title: created.title,
                // The POST response genuinely has no `scheduledAt` field
                // (see `CreatedLiveSession`'s docstring) — but the creator
                // just typed this value into the form below, so it is used
                // here rather than hardcoded to `null`. A hardcoded `null`
                // rendered as "Langsung" for a session scheduled for
                // tomorrow, which corrected itself only on the NEXT list
                // refetch — misleading at exactly the moment a creator is
                // deciding whether to open OBS now or later.
                scheduledAt: scheduledAtIso,
                streamKey: created.streamKey,
                status: created.status,
                hlsPlaybackPath: created.hlsPlaybackPath,
                recordingUrl: null,
                rtmpUrl: created.rtmpUrl,
                whipUrl: created.whipUrl,
              },
              ...sessionsLoad.data,
            ]);
          }}
        />
      ) : null}

      {statusLoad.kind === "ready" && !statusLoad.data.enabled ? (
        <div className="card" data-testid="streaming-disabled-notice">
          <h3>Siaran langsung belum dikonfigurasi</h3>
          <p className="muted">
            Server ini belum dikonfigurasi untuk siaran langsung, sehingga sesi baru belum bisa
            dibuat. Sesi yang sudah pernah dijadwalkan tetap terlihat di atas.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function SessionTable({ sessions }: { sessions: LiveSession[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Sesi</th>
            <th>Status</th>
            <th>Waktu</th>
            <th>Stream key</th>
            <th>Siarkan</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionRow({ session }: { session: LiveSession }) {
  const [revealed, setRevealed] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const badgeClass = `badge badge-${session.status.replace(/_/g, "-")}`;
  // Both come from the same server-side check and are null together (see
  // `types.ts`'s `LiveSession` docstring) — checking either is enough, but
  // both is defensive against that invariant ever drifting.
  const canPublish = session.whipUrl !== null || session.rtmpUrl !== null;

  return (
    <>
      <tr>
        <td>
          {session.title}
          <p className="hint">{liveSessionStatusExplanation(session.status)}</p>
        </td>
        <td>
          <span className={badgeClass}>{liveSessionStatusLabel(session.status)}</span>
        </td>
        <td>{session.scheduledAt !== null ? formatDateTime(session.scheduledAt) : "Langsung"}</td>
        <td>
          {session.streamKey === null ? (
            <span className="muted">—</span>
          ) : revealed ? (
            <CopyableLink url={session.streamKey} label="Stream key" />
          ) : (
            <button type="button" className="button-quiet" onClick={() => setRevealed(true)}>
              Tampilkan stream key
            </button>
          )}
        </td>
        <td>
          {canPublish ? (
            <button
              type="button"
              className="button-quiet"
              onClick={() => setPublishOpen((open) => !open)}
            >
              {publishOpen ? "Sembunyikan" : "Siarkan"}
            </button>
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      </tr>
      {publishOpen ? (
        <tr>
          <td colSpan={5}>
            <PublishOptions
              status={session.status}
              rtmpUrl={session.rtmpUrl}
              whipUrl={session.whipUrl}
              streamKey={session.streamKey}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * WHAT A CREATOR SEES THE MOMENT A SESSION IS CREATED — both ways to
 * publish, plus enough instruction to configure OBS from nothing. This is
 * the ONLY place `rtmpUrl` is ever available as a plain field on
 * `CreatedLiveSession` (see `types.ts`'s docstring: it is never persisted,
 * so it can never be recovered from the list once this panel is gone) — the
 * list endpoint rebuilds it per row instead (Task 2), which is what lets
 * `SessionRow`'s own "Siarkan" toggle offer the identical two panels for a
 * session created in an earlier page-load.
 */
function NewSessionPanel({ session }: { session: CreatedLiveSession }) {
  return (
    <div className="card notice notice-info" data-testid="new-session-panel">
      <h3>Sesi “{session.title}” berhasil dibuat</h3>
      <p className="muted">
        Anda bisa langsung menyiarkan dari browser di bawah, atau memasukkan dua nilai berikut ke
        perangkat lunak siaran Anda (misalnya OBS Studio). Simpan stream key ini baik-baik — siapa
        pun yang memilikinya bisa menyiarkan atas nama sesi ini.
      </p>
      <PublishOptions
        status={session.status}
        rtmpUrl={session.rtmpUrl}
        whipUrl={session.whipUrl}
        streamKey={session.streamKey}
      />
    </div>
  );
}

/**
 * Both publish paths for one session, side by side — the screen this whole
 * module exists to build (Task 3 brief): "Siaran dari browser" and "OBS /
 * Streamlabs", presented together rather than as tabs, so a creator can see
 * both are options without having to discover a toggle first.
 *
 * Each path is gated on its OWN url being non-null rather than on a single
 * combined flag: both come back null together in every real deployment (see
 * `types.ts`), but nothing here assumes that will always stay true.
 */
function PublishOptions({
  status,
  rtmpUrl,
  whipUrl,
  streamKey,
}: {
  status: string;
  rtmpUrl: string | null;
  whipUrl: string | null;
  streamKey: string | null;
}) {
  if (whipUrl === null && rtmpUrl === null) return null;

  return (
    <div className="stack publish-options">
      {whipUrl !== null ? (
        <div className="card">
          <h4>Siaran dari browser</h4>
          <BrowserPublishSection whipUrl={whipUrl} status={status} />
        </div>
      ) : null}
      {rtmpUrl !== null && streamKey !== null ? (
        <div className="card">
          <h4>OBS / Streamlabs</h4>
          <ObsInstructions rtmpUrl={rtmpUrl} streamKey={streamKey} />
        </div>
      ) : null}
    </div>
  );
}

/** The RTMP URL, stream key, and enough OBS instruction for someone who has never configured it. */
function ObsInstructions({ rtmpUrl, streamKey }: { rtmpUrl: string; streamKey: string }) {
  return (
    <>
      <div className="stack">
        <CopyableLink url={rtmpUrl} label="URL RTMP (kolom “Server” di OBS)" />
        <CopyableLink url={streamKey} label="Stream key (kolom “Stream Key” di OBS)" />
      </div>
      <h3>Cara mengatur OBS Studio</h3>
      <ol>
        <li>Buka OBS Studio, lalu klik “Settings” kemudian “Stream”.</li>
        <li>Pilih jenis layanan “Custom…” (kadang tertulis “Custom Streaming Server”).</li>
        <li>Tempelkan URL RTMP di atas ke kolom “Server”.</li>
        <li>Tempelkan stream key di atas ke kolom “Stream Key”.</li>
        <li>Klik “OK”, lalu tekan tombol “Start Streaming” di jendela utama OBS.</li>
        <li>Status sesi ini akan berubah menjadi “Live” begitu OBS mulai mengirim video.</li>
      </ol>
    </>
  );
}

type DeviceStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "unsupported"
  | "permission-denied"
  | "no-device"
  | "device-busy"
  | "error";

/**
 * Every non-happy device status, in Indonesian, each naming what actually
 * went wrong and what to do about it — see this file's own docstring for why
 * that is most of this task's value. `unsupported`/`no-device`/`device-busy`/
 * `error` all point at OBS/Streamlabs as a working alternative; only
 * `permission-denied` does not, because the fix for that one (the browser's
 * own site-settings toggle) is faster than switching tools entirely.
 */
const DEVICE_STATUS_MESSAGE: Record<
  Exclude<DeviceStatus, "idle" | "requesting" | "ready">,
  string
> = {
  unsupported:
    "Peramban ini tidak mendukung siaran langsung dari browser. Gunakan OBS / Streamlabs di " +
    "sebelah, atau buka dasbor ini dari Chrome, Edge, atau Firefox versi terbaru.",
  "permission-denied":
    "Izin kamera/mikrofon ditolak. Buka pengaturan situs di peramban Anda (biasanya lewat ikon " +
    "gembok di sebelah alamat situs), izinkan akses Kamera dan Mikrofon untuk situs ini, lalu " +
    "tekan “Coba lagi”.",
  "no-device":
    "Tidak ditemukan kamera atau mikrofon di perangkat ini. Sambungkan kamera dan mikrofon, lalu " +
    "tekan “Coba lagi” — atau gunakan OBS / Streamlabs di sebelah sebagai alternatif.",
  "device-busy":
    "Kamera atau mikrofon sedang dipakai aplikasi lain. Tutup aplikasi lain yang mungkin " +
    "menggunakannya (misalnya aplikasi video call), lalu tekan “Coba lagi”.",
  error:
    "Tidak dapat mengakses kamera atau mikrofon. Coba lagi, atau gunakan OBS / Streamlabs di " +
    "sebelah sebagai alternatif.",
};

/**
 * Maps a `getUserMedia` rejection to one of this screen's own Indonesian
 * messages.
 *
 * IMPORTANT CAVEAT FOR ANYONE TESTING THIS BY HAND: `getUserMedia` requires a
 * secure context — it works from `https://` and from `http://localhost`
 * (which browsers exempt from the requirement) but from nothing else. Opening
 * this dashboard from a phone against your laptop's bare LAN IP over plain
 * HTTP (`http://192.168.x.x:5173`) throws the SAME `NotAllowedError` a real
 * permission denial does, so this function — correctly — reports
 * "permission-denied" for both, and there is no way to tell them apart from
 * inside the browser. If device access mysteriously "fails" only when
 * testing from a second device, this is almost certainly why; use `https://`
 * or test from the same machine as the dev server instead.
 */
function classifyGetUserMediaError(err: unknown): DeviceStatus {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission-denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-device";
  if (name === "NotReadableError" || name === "TrackStartError") return "device-busy";
  return "error";
}

/**
 * Device pickers, a muted local preview, and go-live/stop — the "Siaran dari
 * browser" half of `PublishOptions`. The WHIP negotiation itself is NOT
 * implemented here: `publishToWhip` (whip-publisher.ts) owns the SDP
 * exchange as pure, unit-testable logic, exactly per the Task 3 brief ("Keep
 * the WHIP mechanics out of the component"). This component only owns
 * device permission, the preview `<video>`, and translating whatever
 * `publishToWhip` throws into what is already an Indonesian message (see
 * `WhipNegotiationError`'s own docstring).
 */
function BrowserPublishSection({ whipUrl, status }: { whipUrl: string; status: string }) {
  const fieldId = useId();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handleRef = useRef<PublishHandle | null>(null);

  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>("idle");
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [microphoneId, setMicrophoneId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Unmounting (collapsing a row's "Siarkan" panel, or navigating away) must
  // not leave a camera light on or a publish running with nothing left able
  // to stop it.
  useEffect(() => {
    return () => {
      handleRef.current?.close();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      window.removeEventListener("beforeunload", beforeUnloadWarning);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function beforeUnloadWarning(event: BeforeUnloadEvent) {
    // Closing THIS tab ends the session permanently (a deferred limitation
    // carried over from the RTMP/OBS path — see this file's own docstring),
    // and a tab is far easier to close by accident than OBS is to quit.
    // `returnValue` has to be set for Chrome; the message text itself is
    // ignored by every modern browser, which shows its own generic wording.
    event.preventDefault();
    event.returnValue = "";
  }

  async function requestAccess(deviceIds?: { cameraId?: string; microphoneId?: string }) {
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) {
      setDeviceStatus("unsupported");
      return;
    }
    setDeviceStatus("requesting");
    setPublishError(null);
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: deviceIds?.cameraId ? { deviceId: { exact: deviceIds.cameraId } } : true,
        audio: deviceIds?.microphoneId ? { deviceId: { exact: deviceIds.microphoneId } } : true,
      });
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = nextStream;
      if (videoRef.current) {
        // happy-dom (this repo's `bun test` DOM) does not implement media
        // playback — `srcObject` is still a plain assignable property there,
        // but guarded anyway so an unexpected environment cannot crash the
        // whole panel over a preview that would not have shown video either
        // way.
        try {
          videoRef.current.srcObject = nextStream;
        } catch {
          // Preview only; the publish path below does not depend on it.
        }
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      setCameras(devices.filter((d) => d.kind === "videoinput"));
      setMicrophones(devices.filter((d) => d.kind === "audioinput"));
      setCameraId(nextStream.getVideoTracks()[0]?.getSettings().deviceId ?? "");
      setMicrophoneId(nextStream.getAudioTracks()[0]?.getSettings().deviceId ?? "");
      setDeviceStatus("ready");
    } catch (err) {
      setDeviceStatus(classifyGetUserMediaError(err));
    }
  }

  async function goLive() {
    if (streamRef.current === null) return;
    setConnecting(true);
    setPublishError(null);
    try {
      const handle = await publishToWhip({ whipUrl, stream: streamRef.current });
      handleRef.current = handle;
      setPublishing(true);
      window.addEventListener("beforeunload", beforeUnloadWarning);
    } catch (err) {
      // `WhipNegotiationError` already carries an Indonesian message naming
      // the likely cause (see whip-publisher.ts) — shown verbatim.
      setPublishError(
        err instanceof Error ? err.message : "Gagal memulai siaran dari browser. Coba lagi."
      );
    } finally {
      setConnecting(false);
    }
  }

  function stopLive() {
    handleRef.current?.close();
    handleRef.current = null;
    setPublishing(false);
    window.removeEventListener("beforeunload", beforeUnloadWarning);
  }

  if (status === "ended") {
    // "the session already `ended` (offer to schedule a new one)" — per the
    // Task 3 brief. Device pickers and the go-live button are not offered at
    // all: the stream key stopped authorising new publishes the moment this
    // session ended (see `liveSessionStatusExplanation`), so there is
    // nothing a browser publish attempt here could succeed at.
    return (
      <p className="muted">
        Sesi ini sudah selesai — stream key-nya tidak bisa dipakai untuk memulai siaran baru.
        Jadwalkan sesi baru di bawah untuk siaran berikutnya.
      </p>
    );
  }

  // "the session already `live` because OBS is publishing (disable the
  // button and explain)" — per the Task 3 brief. `publishing` is THIS
  // panel's own local state (it becomes true only once THIS browser's own
  // `publishToWhip` call succeeds), so a `live` status this panel did not
  // itself cause can only mean an encoder (OBS/Streamlabs) is the one
  // sending video right now.
  const liveViaObs = status === "live" && !publishing;

  return (
    <div className="stack">
      {deviceStatus === "idle" ? (
        <button type="button" className="button-secondary" onClick={() => requestAccess()}>
          Aktifkan kamera &amp; mikrofon
        </button>
      ) : null}

      {deviceStatus === "requesting" ? (
        <p className="muted">Meminta izin kamera &amp; mikrofon...</p>
      ) : null}

      {deviceStatus !== "idle" && deviceStatus !== "requesting" && deviceStatus !== "ready" ? (
        <div>
          <p className="form-error" role="alert">
            {DEVICE_STATUS_MESSAGE[deviceStatus]}
          </p>
          <button type="button" className="button-secondary" onClick={() => requestAccess()}>
            Coba lagi
          </button>
        </div>
      ) : null}

      {deviceStatus === "ready" ? (
        <>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a live self-preview, not media content */}
          <video ref={videoRef} muted autoPlay playsInline className="video-preview" />
          <div className="inline-form">
            <Field label="Kamera" name={`${fieldId}-camera`}>
              <select
                id={`field-${fieldId}-camera`}
                value={cameraId}
                disabled={publishing}
                onChange={(e) => {
                  setCameraId(e.target.value);
                  void requestAccess({ cameraId: e.target.value, microphoneId });
                }}
              >
                {cameras.map((camera, index) => (
                  <option key={camera.deviceId || index} value={camera.deviceId}>
                    {camera.label || `Kamera ${index + 1}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Mikrofon" name={`${fieldId}-microphone`}>
              <select
                id={`field-${fieldId}-microphone`}
                value={microphoneId}
                disabled={publishing}
                onChange={(e) => {
                  setMicrophoneId(e.target.value);
                  void requestAccess({ cameraId, microphoneId: e.target.value });
                }}
              >
                {microphones.map((mic, index) => (
                  <option key={mic.deviceId || index} value={mic.deviceId}>
                    {mic.label || `Mikrofon ${index + 1}`}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {liveViaObs ? (
            <p className="form-error" role="alert">
              Sesi ini sedang live lewat OBS / Streamlabs saat ini. Hentikan siaran itu terlebih
              dahulu sebelum menyiarkan dari browser.
            </p>
          ) : null}

          {publishError !== null ? (
            <p className="form-error" role="alert">
              {publishError}
            </p>
          ) : null}

          {publishing ? (
            <>
              <p className="notice notice-warning" role="alert">
                Jangan tutup atau muat ulang tab ini selama siaran berlangsung — menutup tab akan
                menghentikan siaran ini secara permanen, dan Anda harus menjadwalkan sesi baru
                untuk siaran berikutnya.
              </p>
              <button type="button" className="button-danger" onClick={stopLive}>
                Hentikan siaran
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button-primary"
              onClick={goLive}
              disabled={connecting || liveViaObs}
            >
              {connecting ? "Menghubungkan..." : "Mulai siaran dari browser"}
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}

function ScheduleSessionForm({
  communityId,
  onCreated,
}: {
  communityId: string;
  /** `scheduledAtIso` is `null` for an immediate ("Langsung") session — the
   * SAME value just sent to the server, not re-derived from the response
   * (which does not carry it). */
  onCreated: (session: CreatedLiveSession, scheduledAtIso: string | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setFieldErrors({});

    const body: Record<string, unknown> = { title };
    let scheduledAtIso: string | null = null;
    if (scheduledAt.trim() !== "") {
      const parsed = new Date(scheduledAt);
      if (Number.isNaN(parsed.getTime())) {
        setFieldErrors({ scheduledAt: "Waktu tidak valid." });
        return;
      }
      scheduledAtIso = parsed.toISOString();
      body.scheduledAt = scheduledAtIso;
    }

    setSubmitting(true);
    try {
      const created = await apiFetch<CreatedLiveSession>(`/communities/${communityId}/events`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setTitle("");
      setScheduledAt("");
      onCreated(created, scheduledAtIso);
    } catch (err) {
      if (err instanceof DashboardApiError) {
        if (err.status === 503) {
          // The RAW message here is English (see events.ts's
          // ServiceUnavailableError) — this screen's copy is Bahasa
          // Indonesia throughout, so `err.message` is never shown verbatim
          // for this one status.
          setMessage(
            "Siaran langsung belum dikonfigurasi di server ini. Coba lagi nanti atau hubungi admin."
          );
        } else {
          setFieldErrors(err.fieldErrors);
          setMessage(Object.keys(err.fieldErrors).length > 0 ? null : err.message);
        }
      } else {
        setMessage("Tidak dapat menghubungi server. Coba lagi.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h3>Jadwalkan sesi baru</h3>
      <form onSubmit={submit} className="stack" noValidate>
        <div className="inline-form">
          <Field label="Judul sesi" name="title" error={fieldErrors.title}>
            <input
              id="field-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-invalid={fieldErrors.title !== undefined}
            />
          </Field>
          <Field
            label="Waktu (opsional)"
            name="scheduledAt"
            error={fieldErrors.scheduledAt}
            hint="Kosongkan jika Anda berencana langsung mulai siaran sekarang."
          >
            <input
              id="field-scheduledAt"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              aria-invalid={fieldErrors.scheduledAt !== undefined}
            />
          </Field>
        </div>
        {message !== null ? (
          <p className="form-error" role="alert">
            {message}
          </p>
        ) : null}
        <div>
          <button type="submit" className="button-primary" disabled={submitting}>
            {submitting ? "Menjadwalkan..." : "Jadwalkan sesi"}
          </button>
        </div>
      </form>
    </div>
  );
}
