import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, DashboardApiError } from "../apiClient";
import { formatDateTime, liveSessionStatusExplanation, liveSessionStatusLabel } from "../format";
import { CommunityHeader, CopyableLink, EmptyState, ErrorPanel, Field, NotFoundPanel } from "../ui";
import { useCommunity } from "../useCommunity";
import { useLoad } from "../useLoad";
import type { CreatedLiveSession, LiveSession, StreamingStatus } from "../types";

/**
 * The creator's "Siaran langsung" screen (Task 7): schedule a live session,
 * see every session ever scheduled for this community and its status, and —
 * once a session exists — get the RTMP URL and stream key an encoder (OBS)
 * needs, with enough instruction for someone who has never configured it.
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
 *     moment a creator is actually about to paste it into OBS.
 *  2. Each row's own reveal toggle — collapsed by default, so a screen with
 *     ten past sessions does not print ten secrets at once, but a creator
 *     who lost their OBS settings can still get the key back (per Task 3's
 *     report: "the owner is allowed to see their own key again").
 *
 * `justCreated` is LOCAL STATE, and React Router reuses this exact component
 * instance across a route-param change (switching communities does not
 * remount it) — so it is reset by the effect below the moment `communityId`
 * changes, rather than surviving into a screen about a different community's
 * session. See EventsPage.test.tsx's "does not carry a just-created stream
 * key over" test, which is what pins this.
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
              action="Jadwalkan sesi pertama Anda di bawah ini. Setelah dibuat, Anda akan mendapatkan URL RTMP dan stream key untuk dimasukkan ke OBS."
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
          onCreated={(created) => {
            setJustCreated(created);
            sessionsHandle.update([
              {
                id: created.id,
                communityId: communityId!,
                title: created.title,
                scheduledAt: null,
                streamKey: created.streamKey,
                status: created.status,
                hlsPlaybackPath: created.hlsPlaybackPath,
                recordingUrl: null,
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
  const badgeClass = `badge badge-${session.status.replace(/_/g, "-")}`;

  return (
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
    </tr>
  );
}

/**
 * WHAT A CREATOR SEES THE MOMENT A SESSION IS CREATED — the RTMP URL and
 * stream key, both copyable, plus enough instruction to configure OBS from
 * nothing. This is the ONLY place `rtmpUrl` is ever available (see
 * `types.ts`'s `CreatedLiveSession` docstring: it is never persisted, so it
 * can never be recovered from the list once this panel is gone).
 */
function NewSessionPanel({ session }: { session: CreatedLiveSession }) {
  return (
    <div className="card notice notice-info" data-testid="new-session-panel">
      <h3>Sesi “{session.title}” berhasil dibuat</h3>
      <p className="muted">
        Masukkan dua nilai berikut ke perangkat lunak siaran Anda (misalnya OBS Studio). Simpan
        stream key ini baik-baik — siapa pun yang memilikinya bisa menyiarkan atas nama sesi ini.
      </p>
      <div className="stack">
        <CopyableLink url={session.rtmpUrl} label="URL RTMP (kolom “Server” di OBS)" />
        <CopyableLink url={session.streamKey} label="Stream key (kolom “Stream Key” di OBS)" />
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
    </div>
  );
}

function ScheduleSessionForm({
  communityId,
  onCreated,
}: {
  communityId: string;
  onCreated: (session: CreatedLiveSession) => void;
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
    if (scheduledAt.trim() !== "") {
      const parsed = new Date(scheduledAt);
      if (Number.isNaN(parsed.getTime())) {
        setFieldErrors({ scheduledAt: "Waktu tidak valid." });
        return;
      }
      body.scheduledAt = parsed.toISOString();
    }

    setSubmitting(true);
    try {
      const created = await apiFetch<CreatedLiveSession>(`/communities/${communityId}/events`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setTitle("");
      setScheduledAt("");
      onCreated(created);
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
