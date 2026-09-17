import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faComment, faHeart, faArrowLeft, faFireFlameCurved, faPen, faTrash } from "@fortawesome/free-solid-svg-icons";
import { api, type ApiComment } from "../lib/api";
import { useApi } from "../lib/useApi";
import { useAuth, FullPageMessage } from "../lib/auth";
import { initialsOf, timeAgo } from "../lib/format";
import Avatar from "../components/ui/Avatar";
import Header from "../components/layout/Header";
import PageContainer from "../components/layout/PageContainer";
import PostEditorModal from "../components/feed/PostEditorModal";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import { canManagePost } from "../lib/permissions";

const DAY_MS = 24 * 60 * 60 * 1000;

export default function DiscussionDetail() {
  const { id, postId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [comments, setComments] = useState<ApiComment[]>([]);
  // Overrides the server's like count for comments this session has toggled.
  const [likeOverrides, setLikeOverrides] = useState<Record<string, { likes: number; liked: boolean }>>({});
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [postId]);

  const communityState = useApi(() => api.communities.detail(id!), [id]);
  const postState = useApi(() => api.posts.get(postId!), [postId]);
  const commentsState = useApi(() => api.posts.comments(postId!), [postId]);
  const relatedState = useApi(() => api.communities.feed(id!, { types: "diskusi" }), [id]);
  const tagsState = useApi(() => api.communities.trendingTags(), []);

  useEffect(() => {
    if (commentsState.data) setComments(commentsState.data);
  }, [commentsState.data]);

  const community = communityState.data;
  const post = postState.data;

  const submitReply = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || !postId) return;
    setSending(true);
    setSendError("");
    try {
      const created = await api.posts.addComment(postId, draft.trim());
      setComments((prev) => [...prev, created]);
      setDraft("");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Gagal mengirim balasan");
    } finally {
      setSending(false);
    }
  };

  const toggleLike = async (commentId: string) => {
    try {
      const result = await api.posts.likeComment(commentId);
      setLikeOverrides((prev) => ({ ...prev, [commentId]: result }));
    } catch {
      // A failed like is not worth interrupting the reader for; the count simply
      // stays as it was.
    }
  };

  if (postState.loading || communityState.loading) return <FullPageMessage text="Memuat diskusi…" />;
  if (postState.error || !post) {
    return <FullPageMessage text={postState.error ?? "Diskusi tidak ditemukan"} tone="error" />;
  }

  const communityId = post.communityId;
  const communityName = community?.name ?? "Komunitas";
  const relatedPosts = (relatedState.data ?? []).filter((p) => p.id !== post.id).slice(0, 6);

  // "Aktif" used to be a static flag in the mock. Derived here instead: a reply
  // landed in the last 24 hours.
  const isActive = comments.some((c) => Date.now() - new Date(c.createdAt).getTime() < DAY_MS);
  // Unlike the other detail pages, a plain member can own a diskusi — so this is
  // not just isAdmin. Mirrors AccessPolicy.canManagePost.
  const canManage = canManagePost(post, community?.isAdmin ?? false, user?.id);

  const confirmDelete = async () => {
    setActionError(null);
    setDeleting(true);
    try {
      await api.posts.remove(post.id);
      navigate(`/community/${communityId}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Gagal menghapus diskusi");
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Header
        title="Diskusi"
        breadcrumb={[
          { label: communityName, to: `/community/${communityId}` },
          { label: "Diskusi" },
        ]}
      />
      <PageContainer>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px", gap: 20, paddingBottom: 60 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <button
              onClick={() => navigate(`/community/${communityId}`)}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                background: "none", border: "none", color: "var(--ink-500)", fontSize: 13, fontWeight: 600,
              }}
            >
              <FontAwesomeIcon icon={faArrowLeft} /> Kembali ke Feed
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

          {/* Post utama */}
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: "flex", gap: 12 }}>
              <Avatar initials={initialsOf(post.authorName)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{post.authorName}</span>
                    <span style={{ color: "var(--ink-300)", fontSize: 12.5 }}> · {timeAgo(post.createdAt)}</span>
                  </div>
                  {isActive && <span className="badge badge-active"><span className="dot"></span>Aktif</span>}
                </div>
                <p style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{post.title}</p>
                <p style={{ fontSize: 14.5, color: "var(--ink-700)", lineHeight: 1.65, marginBottom: 14 }}>{post.body}</p>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span className="badge badge-neutral">{post.tag}</span>
                  <span style={{ fontSize: 12.5, color: "var(--ink-500)" }}>
                    <FontAwesomeIcon icon={faComment} /> {comments.length} balasan
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Form balasan baru */}
          <form className="card" onSubmit={submitReply} style={{ padding: 16, display: "flex", gap: 12, alignItems: "center" }}>
            <Avatar initials={user ? user.initials : "?"} color={user?.avatarColor} />
            <input
              className="input"
              placeholder="Tulis balasan..."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{ flex: 1, background: "var(--awan)" }}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={!draft.trim() || sending} style={{ flexShrink: 0 }}>
              {sending ? "Mengirim…" : "Kirim"}
            </button>
          </form>
          {sendError && (
            <p style={{ fontSize: 12.5, color: "var(--merah-senja)", marginTop: -8 }}>{sendError}</p>
          )}

          {/* Daftar komentar */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <h3 style={{ fontSize: 15, fontWeight: 600 }}>
              {comments.length} balasan
            </h3>
            {commentsState.loading && (
              <p style={{ fontSize: 13, color: "var(--ink-500)" }}>Memuat balasan…</p>
            )}
            {commentsState.error && (
              <p style={{ fontSize: 13, color: "var(--merah-senja)" }}>{commentsState.error}</p>
            )}
            {comments.map((c) => {
              const override = likeOverrides[c.id];
              const likes = override ? override.likes : c.likes;
              const liked = override?.liked ?? false;
              return (
                <div key={c.id} className="card" style={{ padding: 18 }}>
                  <div style={{ display: "flex", gap: 12 }}>
                    <Avatar initials={initialsOf(c.authorName)} size={32} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ marginBottom: 4 }}>
                        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{c.authorName}</span>
                        <span style={{ color: "var(--ink-300)", fontSize: 12 }}> · {timeAgo(c.createdAt)}</span>
                      </div>
                      <p style={{ fontSize: 13.5, color: "var(--ink-700)", lineHeight: 1.55, marginBottom: 8 }}>{c.body}</p>
                      <button
                        onClick={() => toggleLike(c.id)}
                        style={{
                          fontSize: 12, color: liked ? "var(--merah-senja)" : "var(--ink-500)",
                          display: "inline-flex", alignItems: "center", gap: 5,
                          background: "none", border: "none", padding: 0, fontWeight: liked ? 700 : 400,
                        }}
                      >
                        <FontAwesomeIcon icon={faHeart} /> {likes}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
            {!commentsState.loading && comments.length === 0 && (
              <p style={{ fontSize: 13, color: "var(--ink-500)" }}>Belum ada balasan. Jadi yang pertama membalas!</p>
            )}
          </div>
        </div>

        {/* Sidebar rekomendasi */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="card" style={{ padding: 18 }}>
            <h4 style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 12, color: "var(--ink-700)" }}>Diskusi lainnya</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {relatedPosts.map((p) => (
                <div
                  key={p.id}
                  onClick={() => navigate(`/community/${communityId}/discussion/${p.id}`)}
                  className="hover-bg"
                  style={{ padding: "10px 8px", borderRadius: 10, cursor: "pointer" }}
                >
                  <p style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.4, marginBottom: 4 }}>{p.title}</p>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 11.5, color: "var(--ink-500)" }}>{p.authorName}</span>
                    <span style={{ fontSize: 11.5, color: "var(--ink-500)" }}>
                      <FontAwesomeIcon icon={faComment} /> {p.replies}
                    </span>
                  </div>
                </div>
              ))}
              {!relatedState.loading && relatedPosts.length === 0 && (
                <p style={{ fontSize: 12.5, color: "var(--ink-500)" }}>Belum ada diskusi lain.</p>
              )}
            </div>
          </div>

          <div className="card" style={{ padding: 18 }}>
            <h4 style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 12, color: "var(--ink-700)" }}>
              <FontAwesomeIcon icon={faFireFlameCurved} style={{ color: "var(--sinyal)" }} /> Topik populer
            </h4>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(tagsState.data ?? []).map((tag) => (
                <span
                  key={tag}
                  onClick={() => navigate(`/community/${communityId}?tab=Feed&topic=${encodeURIComponent(tag.replace(/^#/, ""))}`)}
                  className="badge badge-neutral"
                  style={{ cursor: "pointer" }}
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
        </div>
      </PageContainer>

      {editing && (
        <PostEditorModal
          mode="edit"
          communityId={communityId}
          isAdmin={community?.isAdmin ?? false}
          initial={post}
          topicOptions={post.tag ? [post.tag] : []}
          onAddTopic={() => {}}
          syllabusOptions={[]}
          onAddSyllabus={() => {}}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); postState.reload(); }}
        />
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title="Hapus diskusi ini?"
          subtitle={`${post.authorName} · ${comments.length} balasan`}
          busy={deleting}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={confirmDelete}
        >
          <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{post.title}</p>
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-700)" }}>
            Diskusi ini akan dihapus dan tidak bisa dikembalikan.
            {comments.length > 0 && ` ${comments.length} balasan di dalamnya ikut terhapus.`}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
