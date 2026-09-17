import { useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faComment,
  faEllipsisVertical,
  faPen,
  faTrash,
  faLink,
  faCheck,
  faBullhorn,
  faGraduationCap,
  faCalendarDay,
  faClock,
  faLocationDot,
  faVideo,
  faMusic,
  faFile,
  faUserPlus,
} from "@fortawesome/free-solid-svg-icons";
import type { ApiPost, ApiPostType } from "../../lib/api";
import { initialsOf, timeAgo } from "../../lib/format";
import Avatar from "../ui/Avatar";

const typeIcon: Record<ApiPostType, IconDefinition> = {
  diskusi: faComment,
  pengumuman: faBullhorn,
  konten: faGraduationCap,
  event: faCalendarDay,
  anggota: faUserPlus,
};

const typeBadgeClass: Record<ApiPostType, string> = {
  diskusi: "badge-neutral",
  pengumuman: "badge-pending",
  konten: "badge-active",
  event: "badge-churn",
  anggota: "badge-neutral",
};

type Props = {
  post: ApiPost;
  canManage: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Optional: clicking the topic badge filters the feed by it. */
  onTopicClick?: (topic: string) => void;
  onShare: () => void;
};

export default function FeedPostCard({ post, canManage, onOpen, onEdit, onDelete, onShare, onTopicClick }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleShare = (e: React.MouseEvent) => {
    e.stopPropagation();
    onShare();
    setCopied(true);
    setMenuOpen(false);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div onClick={onOpen} className="card card-clickable" style={{ padding: 20, position: "relative" }}>
      <div style={{ position: "absolute", top: 14, right: 14 }} onClick={(e) => e.stopPropagation()}>
        <button
          aria-label="Opsi post"
          onClick={() => setMenuOpen((v) => !v)}
          className="btn btn-ghost btn-icon"
          style={{ width: 28, height: 28, fontSize: 13, color: "var(--ink-500)" }}
        >
          <FontAwesomeIcon icon={faEllipsisVertical} />
        </button>
        {menuOpen && (
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 9 }} onClick={() => setMenuOpen(false)} />
            <div
              className="card"
              style={{
                position: "absolute", top: 32, right: 0, width: 170, padding: 6, zIndex: 10,
                boxShadow: "var(--shadow-card)", display: "flex", flexDirection: "column", gap: 2,
              }}
            >
              {canManage && (
                <button
                  onClick={(e) => { e.stopPropagation(); onEdit(); setMenuOpen(false); }}
                  className="hover-bg"
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, border: "none", background: "none", fontSize: 13, color: "var(--ink-700)", textAlign: "left" }}
                >
                  <FontAwesomeIcon icon={faPen} /> Edit
                </button>
              )}
              {canManage && (
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(); setMenuOpen(false); }}
                  className="hover-bg"
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, border: "none", background: "none", fontSize: 13, color: "var(--merah-senja)", textAlign: "left" }}
                >
                  <FontAwesomeIcon icon={faTrash} /> Hapus
                </button>
              )}
              <button
                onClick={handleShare}
                className="hover-bg"
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 8, border: "none", background: "none", fontSize: 13, color: "var(--ink-700)", textAlign: "left" }}
              >
                <FontAwesomeIcon icon={copied ? faCheck : faLink} /> {copied ? "Tersalin!" : "Bagikan link"}
              </button>
            </div>
          </>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, paddingRight: 30 }}>
        <Avatar initials={initialsOf(post.authorName)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
            <div>
              <span style={{ fontWeight: 600, fontSize: 14 }}>{post.authorName}</span>
              <span style={{ color: "var(--ink-300)", fontSize: 12.5 }}> · {timeAgo(post.createdAt)}</span>
            </div>
          </div>

          <p style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{post.title}</p>
          <p style={{ fontSize: 13.5, color: "var(--ink-700)", lineHeight: 1.55, marginBottom: 10 }}>{post.body}</p>

          {post.attachments && post.attachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {post.attachments.map((a) =>
                a.kind === "image" ? (
                  <img key={a.id} src={a.url} alt={a.name} style={{ width: 90, height: 90, objectFit: "cover", borderRadius: 10 }} />
                ) : (
                  <span key={a.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 8, background: "var(--awan)", fontSize: 11.5, color: "var(--ink-700)" }}>
                    <FontAwesomeIcon icon={a.kind === "video" ? faVideo : a.kind === "audio" ? faMusic : faFile} /> {a.name}
                  </span>
                )
              )}
            </div>
          )}

          {post.type === "event" && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 10, fontSize: 12.5, color: "var(--ink-500)" }}>
              {post.eventDate && (
                <span><FontAwesomeIcon icon={faCalendarDay} /> {post.eventDate}</span>
              )}
              {post.eventTime && (
                <span><FontAwesomeIcon icon={faClock} /> {post.eventTime}</span>
              )}
              {post.eventLocation && (
                <span><FontAwesomeIcon icon={faLocationDot} /> {post.eventLocation}</span>
              )}
              {post.hasLiveRoom && (
                <span style={{ color: "var(--merah-senja)" }}><FontAwesomeIcon icon={faVideo} /> Live room</span>
              )}
            </div>
          )}

          {post.type === "anggota" && post.inviteTarget && (
            <div style={{ marginBottom: 10, fontSize: 12.5, color: "var(--ink-500)" }}>
              <FontAwesomeIcon icon={faUserPlus} /> Diundang: {post.inviteTarget}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className={`badge ${typeBadgeClass[post.type]}`}>
              <FontAwesomeIcon icon={typeIcon[post.type]} /> {post.tag}
            </span>
            {/* The subject, distinct from the type badge beside it. Clicking it
                filters the feed, so the card's own open handler must not fire. */}
            {post.topic && (
              <button
                className="badge badge-neutral"
                title={`Lihat semua post bertopik ${post.topic}`}
                onClick={(e) => { e.stopPropagation(); onTopicClick?.(post.topic!); }}
                style={{ border: "none", cursor: onTopicClick ? "pointer" : "default" }}
              >
                #{post.topic}
              </button>
            )}
            {post.type === "diskusi" && (
              <span style={{ fontSize: 12.5, color: "var(--ink-500)" }}>
                <FontAwesomeIcon icon={faComment} /> {post.replies} balasan
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
