import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowLeft, faBullhorn, faPen, faTrash } from "@fortawesome/free-solid-svg-icons";
import { api } from "../lib/api";
import { useApi } from "../lib/useApi";
import { useAuth, FullPageMessage } from "../lib/auth";
import { timeAgo } from "../lib/format";
import Header from "../components/layout/Header";
import PageContainer from "../components/layout/PageContainer";
import PostEditorModal from "../components/feed/PostEditorModal";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import { canManagePost } from "../lib/permissions";

const NEW_WINDOW_MS = 48 * 60 * 60 * 1000;

/** The mock carried a static isNew flag; now it is derived from age. */
const isNew = (createdAt: string) => Date.now() - new Date(createdAt).getTime() < NEW_WINDOW_MS;

export default function AnnouncementDetail() {
  const { id, announcementId } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [announcementId]);

  const { user } = useAuth();
  const communityState = useApi(() => api.communities.detail(id!), [id]);
  const announcementState = useApi(() => api.posts.get(announcementId!), [announcementId]);
  const othersState = useApi(() => api.communities.announcements(id!), [id]);

  // Before the early returns below — hooks cannot run conditionally.
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const confirmDelete = async () => {
    if (!announcementState.data) return;
    setActionError(null);
    setDeleting(true);
    try {
      await api.posts.remove(announcementState.data.id);
      // Its subject is gone, so this page would 404 on reload.
      navigate(`/community/${announcementState.data.communityId}?tab=Pengumuman`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Gagal menghapus pengumuman");
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  if (announcementState.loading || communityState.loading) return <FullPageMessage text="Memuat pengumuman…" />;
  if (announcementState.error || !announcementState.data) {
    return <FullPageMessage text={announcementState.error ?? "Pengumuman tidak ditemukan"} tone="error" />;
  }

  const announcement = announcementState.data;
  const communityId = announcement.communityId;
  const communityName = communityState.data?.name ?? "Komunitas";
  const otherAnnouncements = (othersState.data ?? []).filter((a) => a.id !== announcement.id);
  const canManage = canManagePost(announcement, communityState.data?.isAdmin ?? false, user?.id);

  return (
    <>
      <Header
        title="Pengumuman"
        breadcrumb={[
          { label: communityName, to: `/community/${communityId}` },
          { label: "Pengumuman" },
        ]}
      />
      <PageContainer>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 20, paddingBottom: 60 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <button
                onClick={() => navigate(`/community/${communityId}?tab=Pengumuman`)}
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  background: "none", border: "none", color: "var(--ink-500)", fontSize: 13, fontWeight: 600,
                }}
              >
                <FontAwesomeIcon icon={faArrowLeft} /> Kembali ke Pengumuman
              </button>

              {canManage && (
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
                    <FontAwesomeIcon icon={faPen} /> Edit
                  </button>
                  <button
                    className="btn btn-ghost btn-sm" onClick={() => setConfirmingDelete(true)}
                    style={{ color: "var(--merah-senja)" }}
                  >
                    <FontAwesomeIcon icon={faTrash} /> Hapus
                  </button>
                </div>
              )}
            </div>

            {actionError && <p style={{ fontSize: 13, color: "var(--merah-senja)" }}>{actionError}</p>}

            <div className="card" style={{ padding: 24, position: "relative" }}>
              {isNew(announcement.createdAt) && (
                <span className="badge badge-pending" style={{ position: "absolute", top: 20, right: 20 }}>
                  Baru
                </span>
              )}
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, paddingRight: 60 }}>
                <span style={{ color: "var(--sinyal)", fontSize: 18 }}>
                  <FontAwesomeIcon icon={faBullhorn} />
                </span>
                <p style={{ fontSize: 19, fontWeight: 700 }}>{announcement.title}</p>
              </div>
              <p style={{ fontSize: 14.5, color: "var(--ink-700)", lineHeight: 1.7, marginBottom: 14 }}>{announcement.body}</p>
              <p style={{ fontSize: 12.5, color: "var(--ink-500)" }}>
                {announcement.authorName} · {timeAgo(announcement.createdAt)}
              </p>
            </div>
          </div>

          {/* Sidebar */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div className="card" style={{ padding: 18 }}>
              <h4 style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 12, color: "var(--ink-700)" }}>Pengumuman lainnya</h4>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {othersState.loading && (
                  <p style={{ fontSize: 12.5, color: "var(--ink-500)" }}>Memuat…</p>
                )}
                {otherAnnouncements.map((a) => (
                  <div
                    key={a.id}
                    onClick={() => navigate(`/community/${communityId}/announcement/${a.id}`)}
                    className="hover-bg"
                    style={{ padding: "10px 8px", borderRadius: 10, cursor: "pointer" }}
                  >
                    <p style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4, marginBottom: 4 }}>{a.title}</p>
                    <p style={{ fontSize: 11.5, color: "var(--ink-500)" }}>
                      {a.authorName} · {timeAgo(a.createdAt)}
                    </p>
                  </div>
                ))}
                {!othersState.loading && otherAnnouncements.length === 0 && (
                  <p style={{ fontSize: 12.5, color: "var(--ink-500)" }}>Belum ada pengumuman lain.</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </PageContainer>

      {editing && (
        <PostEditorModal
          mode="edit"
          communityId={communityId}
          isAdmin={communityState.data?.isAdmin ?? false}
          initial={announcement}
          topicOptions={[]}
          onAddTopic={() => {}}
          syllabusOptions={[]}
          onAddSyllabus={() => {}}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); announcementState.reload(); othersState.reload(); }}
        />
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title="Hapus pengumuman ini?"
          subtitle={`${announcement.authorName} · ${timeAgo(announcement.createdAt)}`}
          busy={deleting}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={confirmDelete}
        >
          <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{announcement.title}</p>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-700)" }}>
            Pengumuman ini akan dihapus dari komunitas dan tidak bisa dikembalikan.
            Komentar yang menyertainya ikut terhapus.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
