import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowLeft,
  faTowerBroadcast,
  faVideo,
  faCalendarDay,
  faClock,
  faLocationDot,
  faVideoCamera,
  faPen,
  faTrash,
  faArrowUpRightFromSquare,
} from "@fortawesome/free-solid-svg-icons";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import { useAuth, FullPageMessage } from "../lib/auth";
import Header from "../components/layout/Header";
import PageContainer from "../components/layout/PageContainer";
import PostEditorModal from "../components/feed/PostEditorModal";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import StreamKeyPanel from "../components/live/StreamKeyPanel";
import { canManagePost } from "../lib/permissions";

/** eventDate is stored as a display string like "10 Sep". */
function splitEventDate(raw: string | null): { day: string; month: string } {
  if (!raw) return { day: "—", month: "" };
  const parts = raw.trim().split(/\s+/);
  return { day: parts[0] ?? raw, month: parts.slice(1).join(" ") };
}

export default function EventDetail() {
  const { id, eventId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [eventId]);

  const communityState = useApi(() => api.communities.detail(id!), [id]);
  const eventState = useApi(() => api.posts.get(eventId!), [eventId]);

  // Declared before the early returns below — hooks cannot run conditionally.
  const [editing, setEditing] = useState(false);
  // Opening the panel is what provisions the community's live room, so it stays
  // shut until an admin actually means to broadcast.
  const [streaming, setStreaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // The join button below depends on whether a session is on air, which changes
  // without anything on this page doing it. Re-ask periodically rather than
  // leaving a member looking at a stale "belum dimulai" while the host streams.
  useEffect(() => {
    const timer = setInterval(() => communityState.reload(), 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const confirmDelete = async () => {
    if (!eventState.data) return;
    setActionError(null);
    setDeleting(true);
    try {
      await api.posts.remove(eventState.data.id);
      // The page's subject is gone, so staying here would 404 on reload.
      navigate(`/community/${eventState.data.communityId}?tab=Kegiatan`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Gagal menghapus event");
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  // First load only — the 30s live-state poll below sets `loading` again, and
  // blanking the whole page for it would flash a spinner over someone reading.
  if ((eventState.loading && !eventState.data) || (communityState.loading && !communityState.data)) {
    return <FullPageMessage text="Memuat event…" />;
  }
  if (eventState.error || !eventState.data) {
    return <FullPageMessage text={eventState.error ?? "Event tidak ditemukan"} tone="error" />;
  }

  const event = eventState.data;
  const community = communityState.data;
  const communityId = event.communityId;
  const communityName = community?.name ?? "Komunitas";
  const communityColor = community?.color ?? "var(--langit)";

  const { day, month } = splitEventDate(event.eventDate);
  // Two different claims, kept apart deliberately:
  //   hasLiveRoom — this event is MEANT to have a live room (an author's setting)
  //   onAir       — a session for this community is broadcasting RIGHT NOW
  // The mock conflated them, so every event with the checkbox ticked showed a red
  // "Live" badge and a join button forever, whether or not anything existed to join.
  const hasLiveRoom = event.hasLiveRoom;
  const onAir = Boolean(community?.isLive);
  const canManage = canManagePost(event, community?.isAdmin ?? false, user?.id);

  return (
    <>
      <Header
        title="Detail Event"
        breadcrumb={[
          { label: communityName, to: `/community/${communityId}` },
          { label: "Detail Event" },
        ]}
      />
      <PageContainer>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16, paddingBottom: 60 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <button
              onClick={() => navigate(`/community/${communityId}?tab=Kegiatan`)}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                background: "none", border: "none", color: "var(--ink-500)", fontSize: 13, fontWeight: 600,
              }}
            >
              <FontAwesomeIcon icon={faArrowLeft} /> Kembali ke Kegiatan
            </button>

            {/* Server-side this is canManagePost, which admins pass for any post. */}
            {canManage && (
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
                  <FontAwesomeIcon icon={faPen} /> Edit
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setConfirmingDelete(true)}
                  style={{ color: "var(--merah-senja)" }}
                >
                  <FontAwesomeIcon icon={faTrash} /> Hapus
                </button>
              </div>
            )}
          </div>

          {actionError && (
            <p style={{ fontSize: 13, color: "var(--merah-senja)" }}>{actionError}</p>
          )}

          {/* Banner tanggal + tipe */}
          <div
            className="card"
            style={{
              padding: 0, overflow: "hidden", border: "none",
              background: `linear-gradient(135deg, ${communityColor}, var(--langit-dark))`,
            }}
          >
            <div style={{ padding: 28, display: "flex", alignItems: "center", gap: 20 }}>
              <div
                style={{
                  width: 64, textAlign: "center", flexShrink: 0, background: "rgba(255,255,255,0.16)",
                  borderRadius: 14, padding: "12px 0",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 700, color: "#fff" }}>{month}</div>
                <div style={{ fontSize: 26, fontWeight: 700, color: "#fff" }}>{day}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span className={`badge ${onAir ? "badge-churn" : "badge-neutral"}`} style={{ marginBottom: 8 }}>
                  <FontAwesomeIcon icon={hasLiveRoom ? faVideo : faCalendarDay} />{" "}
                  {onAir ? "Sedang live" : hasLiveRoom ? "Ruang live" : "Event"}
                </span>
                <h2 style={{ fontSize: 20, fontWeight: 700, color: "#fff", marginTop: 8 }}>{event.title}</h2>
                {event.eventTime && (
                  <p style={{ fontSize: 13, color: "rgba(255,255,255,0.85)", marginTop: 4 }}>
                    <FontAwesomeIcon icon={faClock} /> {event.eventTime}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Deskripsi */}
          <div className="card" style={{ padding: 24 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>Deskripsi</h3>
            <p style={{ fontSize: 14, color: "var(--ink-700)", lineHeight: 1.7 }}>{event.body}</p>
            {event.eventLocation && (
              <p style={{ fontSize: 13, color: "var(--ink-500)", marginTop: 14, display: "flex", alignItems: "center", gap: 8 }}>
                <FontAwesomeIcon icon={faLocationDot} /> {event.eventLocation}
              </p>
            )}
          </div>

          {/* Tautan meeting eksternal — Zoom/Meet/Teams. Rendered above the live
              room card because it is the thing that actually works today. */}
          {event.meetingUrl && (
            <div className="card" style={{ padding: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>Meeting online</p>
                <p style={{ fontSize: 12.5, color: "var(--ink-500)", wordBreak: "break-all" }}>{event.meetingUrl}</p>
              </div>
              <a
                className="btn btn-primary"
                href={event.meetingUrl}
                target="_blank"
                // noopener: the meeting host must not get a handle on this tab.
                rel="noreferrer noopener"
                style={{ flexShrink: 0 }}
              >
                <FontAwesomeIcon icon={faArrowUpRightFromSquare} /> Gabung meeting
              </a>
            </div>
          )}

          {/* Kredensial siaran — admin only. The server decides this too: the
              endpoint behind the panel is admin-gated, so this flag is the usual
              rendering hint, never the control. */}
          {hasLiveRoom && community?.isAdmin && (
            streaming ? (
              <StreamKeyPanel communityId={communityId} />
            ) : (
              <div className="card" style={{ padding: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>Mulai live streaming</p>
                  <p style={{ fontSize: 12.5, color: "var(--ink-500)" }}>
                    Ambil Server dan Stream Key untuk dipasang di OBS.
                  </p>
                </div>
                <button className="btn btn-primary" onClick={() => setStreaming(true)} style={{ flexShrink: 0 }}>
                  <FontAwesomeIcon icon={faTowerBroadcast} /> Mulai live streaming
                </button>
              </div>
            )
          )}

          {/* Aksi: hanya kalau memang ada yang bisa digabung sekarang. */}
          {hasLiveRoom && onAir && (
            <div className="card" style={{ padding: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
              <div>
                <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>Sedang live sekarang</p>
                <p style={{ fontSize: 12.5, color: "var(--ink-500)" }}>Host sudah mulai menyiarkan — masuk untuk menonton.</p>
              </div>
              <button className="btn btn-primary" onClick={() => navigate(`/live/${communityId}`)} style={{ flexShrink: 0 }}>
                <FontAwesomeIcon icon={faVideoCamera} /> Gabung Live Room
              </button>
            </div>
          )}

          {hasLiveRoom && !onAir && (
            <div className="card" style={{ padding: 20, background: "var(--awan)", border: "none" }}>
              <p style={{ fontSize: 13, color: "var(--ink-500)", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ background: "var(--ink-300)", width: 8, height: 8, borderRadius: "50%", display: "inline-block" }} />
                Ruang live untuk event ini belum dimulai. Tombol gabung muncul begitu host menyiarkan.
              </p>
            </div>
          )}

          {!hasLiveRoom && (
            <div className="card" style={{ padding: 20, background: "var(--awan)", border: "none" }}>
              <p style={{ fontSize: 13, color: "var(--ink-500)", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ background: "var(--ink-300)", width: 8, height: 8, borderRadius: "50%", display: "inline-block" }} />
                Event ini tidak memiliki live room — cukup catat jadwalnya, tanpa sesi streaming.
              </p>
            </div>
          )}

        </div>
      </PageContainer>

      {editing && (
        <PostEditorModal
          mode="edit"
          communityId={communityId}
          isAdmin={canManage}
          initial={event}
          // An event carries no topic/syllabus pickers, and the type is immutable
          // on edit, so these stay empty rather than inventing options here.
          topicOptions={[]}
          onAddTopic={() => {}}
          syllabusOptions={[]}
          onAddSyllabus={() => {}}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); eventState.reload(); }}
        />
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title="Hapus event ini?"
          subtitle={`${event.authorName} · ${event.eventDate ?? "tanpa tanggal"}`}
          busy={deleting}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={confirmDelete}
        >
          <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{event.title}</p>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-700)" }}>
            Event ini akan dihapus dari kalender komunitas dan tidak bisa dikembalikan.
            Komentar yang menyertainya ikut terhapus.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
