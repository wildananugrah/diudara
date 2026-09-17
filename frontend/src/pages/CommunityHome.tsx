import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faVideo,
  faFileLines,
  faHeadphones,
  faClipboardQuestion,
  faComment,
  faCalendarDay,
  faGraduationCap,
  faBullhorn,
  faFile,
  faDownload,
  faXmark,
  faFilter,
  faArrowUpWideShort,
  faPlus,
  faUserPlus,
  faShareNodes,
  faCheck,
  faPen,
  faTrash,
  faUpload,
  faUserMinus,
} from "@fortawesome/free-solid-svg-icons";
import {
  api,
  tokenStore,
  type ApiDocument,
  type ApiMember,
  type ApiPost,
  type ApiPostType,
  type ApiSyllabusItem,
  type ApiSyllabusItemType,
  type ApiTopic,
  type ApiAttachment,
} from "../lib/api";
import { useApi } from "../lib/useApi";
import { canManagePost } from "../lib/permissions";
import { useAuth } from "../lib/auth";
import { formatBytes, formatCount, formatRupiah, initialsOf, timeAgo } from "../lib/format";
import Avatar from "../components/ui/Avatar";
import ConfirmDialog from "../components/ui/ConfirmDialog";
import Header from "../components/layout/Header";
import PageContainer from "../components/layout/PageContainer";
import { OPEN_CHAT_EVENT, type OpenChatRequest } from "../components/chat/FloatingChat";
import FeedPostCard from "../components/feed/FeedPostCard";
import PostEditorModal from "../components/feed/PostEditorModal";
import QuizPanel from "../components/materi/QuizPanel";

const tabs = ["Feed", "Materi", "Anggota", "Kegiatan", "Pengumuman", "Dokumen"] as const;
type Tab = (typeof tabs)[number];

const typeIcon: Record<string, IconDefinition> = { video: faVideo, ebook: faFileLines, audio: faHeadphones, quiz: faClipboardQuestion };
const statusBadge: Record<string, string> = { active: "badge-active", pending: "badge-pending", churned: "badge-churn" };
const statusLabel: Record<string, string> = { active: "Aktif", pending: "Menunggu", churned: "Churned" };
const roleLabel: Record<string, string> = { owner: "Pemilik", admin: "Admin", member: "Member" };

/** Used in the delete confirmation, so the dialog names what is actually going. */
const postTypeLabel: Record<string, string> = {
  diskusi: "diskusi", pengumuman: "pengumuman", konten: "materi",
  event: "kegiatan", anggota: "postingan anggota",
};

const libraryTypeIcon: Record<string, IconDefinition> = { document: faFileLines, video: faVideo, file: faFile };

const MONTHS_ID = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const WEEKDAYS_ID = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const weekdayLabels = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

/**
 * eventDate is free-form text on the API: seeded rows read "10 Sep" while the
 * editor's <input type="date"> produces "2026-09-15". Both are parsed here so
 * the calendar can place either; anything unparseable still shows in the agenda.
 */
function parseEventDate(raw: string | null): Date | null {
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const short = /^(\d{1,2})\s+([A-Za-z]{3})/.exec(raw.trim());
  if (short) {
    const key = short[2]!.toLowerCase();
    const idIdx = ["jan", "feb", "mar", "apr", "mei", "jun", "jul", "agu", "sep", "okt", "nov", "des"].indexOf(key);
    const enIdx = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(key);
    const month = idIdx >= 0 ? idIdx : enIdx;
    if (month >= 0) return new Date(new Date().getFullYear(), month, Number(short[1]));
  }
  return null;
}

function buildMonthCells(year: number, month: number) {
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Senin = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** Path (relative to /community/:id/) for the detail page a post links to. */
function linkForPost(post: ApiPost): string | null {
  switch (post.type) {
    case "diskusi": return `discussion/${post.id}`;
    case "event": return `event/${post.id}`;
    case "pengumuman": return `announcement/${post.id}`;
    case "konten": return "?tab=Materi";
    default: return null;
  }
}

function openMemberChat(userId: string, name: string, color?: string) {
  // Typed as OpenChatRequest so the field names stay in step with the listener —
  // CustomEvent.detail is `any` at the dispatch site, so nothing else would
  // catch a rename here.
  const detail: OpenChatRequest = { userId, name, initials: initialsOf(name), color };
  window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail }));
}

function StateNote({ loading, error, empty, emptyText }: { loading: boolean; error: string | null; empty?: boolean; emptyText?: string }) {
  if (loading) return <p style={{ fontSize: 13, color: "var(--ink-500)", padding: "12px 2px" }}>Memuat…</p>;
  if (error) return <p style={{ fontSize: 13, color: "var(--merah-senja)", padding: "12px 2px" }}>{error}</p>;
  if (empty) return <p style={{ fontSize: 13, color: "var(--ink-500)", padding: "12px 2px" }}>{emptyText ?? "Belum ada data."}</p>;
  return null;
}

const MATERI_TYPES: Array<{ value: ApiSyllabusItemType; label: string }> = [
  { value: "video", label: "Video" },
  { value: "ebook", label: "E-book" },
  { value: "audio", label: "Audio" },
  { value: "quiz", label: "Kuis" },
];

const emptyPane: React.CSSProperties = {
  borderRadius: 14, marginBottom: 18, padding: 36, background: "var(--awan)",
  display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center",
};

/**
 * Renders the lesson itself. `/api/uploads/:id` streams inline and needs no
 * Authorization header, so the media elements can point straight at it.
 */
function MateriPlayer({ item, isAdmin }: { item: ApiSyllabusItem; isAdmin: boolean }) {
  // A quiz carries questions instead of a file.
  if (item.type === "quiz") return <QuizPanel itemId={item.id} isAdmin={isAdmin} />;

  // embedUrl is only ever set for video/audio — the server refuses to derive it
  // for an e-book, so a document link can never render as a video frame.
  if (item.embedUrl) {
    return (
      <iframe
        src={item.embedUrl} title={item.title}
        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        style={{ width: "100%", aspectRatio: "16/9", borderRadius: 14, marginBottom: 18, border: "none", background: "#000" }}
      />
    );
  }

  // A linked lesson that is not a YouTube embed: a direct audio file plays in
  // place; anything else opens in a new tab rather than in an iframe, since the
  // URL is creator-supplied and we are not embedding arbitrary third parties.
  if (item.sourceUrl) {
    if (item.type === "audio") {
      return (
        <div style={{ borderRadius: 14, marginBottom: 18, padding: 20, background: "var(--awan)" }}>
          <audio controls src={item.sourceUrl} preload="metadata" style={{ width: "100%" }} />
        </div>
      );
    }
    return (
      <div style={emptyPane}>
        <span style={{ fontSize: 34, color: "var(--langit)" }}><FontAwesomeIcon icon={typeIcon[item.type] ?? faFile} /></span>
        <a className="btn btn-secondary btn-sm" href={item.sourceUrl} target="_blank" rel="noreferrer noopener">
          <FontAwesomeIcon icon={faDownload} /> Buka materi
        </a>
        <p style={{ fontSize: 11.5, color: "var(--ink-500)", wordBreak: "break-all" }}>{item.sourceUrl}</p>
      </div>
    );
  }

  if (!item.file) {
    return (
      <div style={emptyPane}>
        <span style={{ fontSize: 34, color: "var(--kabut)" }}><FontAwesomeIcon icon={typeIcon[item.type] ?? faFile} /></span>
        <p style={{ fontSize: 13, color: "var(--ink-500)" }}>Belum ada file untuk materi ini.</p>
      </div>
    );
  }

  if (item.type === "video") {
    return (
      <video
        controls src={item.file.url} preload="metadata"
        style={{ width: "100%", aspectRatio: "16/9", borderRadius: 14, marginBottom: 18, background: "#000" }}
      />
    );
  }

  if (item.type === "audio") {
    return (
      <div style={{ borderRadius: 14, marginBottom: 18, padding: 20, background: "var(--awan)" }}>
        <audio controls src={item.file.url} preload="metadata" style={{ width: "100%" }} />
      </div>
    );
  }

  // ebook. PDFs preview inline; anything else (epub) only offers the open link,
  // since an <iframe> would render a broken frame for it.
  const isPdf = /\.pdf$/i.test(item.file.name);
  return (
    <div style={{ marginBottom: 18 }}>
      {isPdf && (
        <iframe
          src={item.file.url} title={item.file.name}
          style={{ width: "100%", height: 460, borderRadius: 14, border: "1px solid var(--ink-150)", marginBottom: 10 }}
        />
      )}
      <a className="btn btn-secondary btn-sm" href={item.file.url} target="_blank" rel="noreferrer">
        <FontAwesomeIcon icon={faDownload} /> Buka {item.file.name}
      </a>
    </div>
  );
}

/** Which file types each materi kind expects, for the picker's accept filter. */
const ACCEPT_FOR: Record<string, string> = {
  video: "video/*",
  audio: "audio/*",
  ebook: ".pdf,.epub,application/pdf,application/epub+zip",
};

export type MateriItemDraft = {
  title: string; type: string; duration: string;
  uploadId?: string | null; sourceUrl?: string | null;
};

/**
 * Which item types may point at an external link, and what that link may be.
 * Mirrors LINKABLE_ITEM_TYPES and requireSource on the server, which are the
 * actual enforcement — these only shape the form.
 */
const canLink = (type: string) => type === "video" || type === "audio" || type === "ebook";

const LINK_LABEL: Record<string, string> = {
  video: "Tautan YouTube",
  audio: "Tautan audio",
  ebook: "Tautan e-book",
};

const LINK_PLACEHOLDER: Record<string, string> = {
  video: "https://youtu.be/…",
  audio: "https://…/rekaman.mp3 atau tautan YouTube",
  ebook: "https://…/modul.pdf",
};

/**
 * Add/edit form for one materi item. Local state only — the parent owns the
 * list and reloads it after the save resolves.
 *
 * The file is uploaded as soon as it is picked (POST /uploads) and only its id
 * travels with the save, matching how PostEditorModal handles attachments.
 */
function MateriItemForm({ initial, busy, onSubmit, onCancel }: {
  initial?: ApiSyllabusItem;
  busy: boolean;
  onSubmit: (value: MateriItemDraft) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [type, setType] = useState(initial?.type ?? "video");
  const [duration, setDuration] = useState(initial?.duration ?? "");
  const [file, setFile] = useState<ApiAttachment | null>(initial?.file ?? null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // A lesson has one source, so the two inputs are mutually exclusive by design.
  const [source, setSource] = useState<"upload" | "link">(initial?.sourceUrl ? "link" : "upload");
  const [sourceUrl, setSourceUrl] = useState(initial?.sourceUrl ?? "");

  const pickFile = async (picked: File | undefined) => {
    if (!picked) return;
    setUploadError(null);
    setUploading(true);
    try {
      setFile(await api.uploads.upload(picked));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Gagal mengunggah file");
    } finally {
      setUploading(false);
    }
  };

  const locked = busy || uploading;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
      <input
        className="input" autoFocus placeholder="Judul materi"
        value={title} onChange={(e) => setTitle(e.target.value)}
        style={{ fontSize: 13 }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <select
          className="input" value={type}
          onChange={(e) => {
            const next = e.target.value;
            setType(next);
            // Switching to a type that cannot link must not leave a link staged.
            if (!canLink(next)) { setSource("upload"); setSourceUrl(""); }
          }}
          style={{ fontSize: 13, flex: 1 }}
        >
          {MATERI_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <input
          className="input" placeholder="18:20 / 12 hal"
          value={duration} onChange={(e) => setDuration(e.target.value)}
          style={{ fontSize: 13, flex: 1 }}
        />
      </div>

      {/* What counts as a valid link differs per type — see LINK_LABEL. */}
      {canLink(type) && (
        <div style={{ display: "flex", gap: 4 }}>
          {([["upload", "Unggah file"], ["link", LINK_LABEL[type] ?? "Tautan"]] as const).map(([value, label]) => (
            <button
              key={value} className="btn btn-sm" disabled={locked}
              onClick={() => {
                setSource(value);
                // Switching source clears the other one so only one can be sent.
                if (value === "upload") setSourceUrl(""); else setFile(null);
              }}
              style={{
                flex: 1, fontSize: 12,
                background: source === value ? "var(--langit)" : "var(--surface)",
                color: source === value ? "var(--awan)" : "var(--ink-700)",
                border: source === value ? "none" : "1px solid var(--ink-150)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {canLink(type) && source === "link" && (
        <input
          className="input" placeholder={LINK_PLACEHOLDER[type] ?? "https://…"}
          value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)}
          style={{ fontSize: 13 }}
        />
      )}

      {/* A quiz carries questions, so it gets no source input at all. */}
      {type !== "quiz" && (!canLink(type) || source === "upload") && (
        file ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <FontAwesomeIcon icon={typeIcon[type] ?? faFile} style={{ color: "var(--langit)", flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {file.name}
            </span>
            <button
              className="btn btn-ghost btn-sm" disabled={locked}
              onClick={() => setFile(null)} title="Hapus file"
              style={{ color: "var(--merah-senja)", flexShrink: 0 }}
            >
              <FontAwesomeIcon icon={faXmark} />
            </button>
          </div>
        ) : (
          <label
            className="btn btn-ghost btn-sm"
            style={{ justifyContent: "flex-start", cursor: locked ? "default" : "pointer" }}
          >
            <FontAwesomeIcon icon={faUpload} />
            {uploading ? " Mengunggah…" : " Pilih file (maks 64MB)"}
            <input
              type="file" hidden disabled={locked} accept={ACCEPT_FOR[type] ?? undefined}
              onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }}
            />
          </label>
        )
      )}
      {uploadError && <p style={{ fontSize: 12, color: "var(--merah-senja)" }}>{uploadError}</p>}

      <div style={{ display: "flex", gap: 6 }}>
        <button
          className="btn btn-secondary btn-sm"
          disabled={locked || !title.trim()}
          onClick={() => onSubmit({
            title: title.trim(), type, duration: duration.trim(),
            // null (not undefined) so clearing a source actually detaches it.
            uploadId: source === "upload" ? file?.id ?? null : null,
            sourceUrl: source === "link" ? sourceUrl.trim() || null : null,
          })}
        >
          Simpan
        </button>
        <button className="btn btn-ghost btn-sm" disabled={locked} onClick={onCancel}>Batal</button>
      </div>
    </div>
  );
}

export default function CommunityHome() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get("tab");
  const [tab, setTab] = useState<Tab>((tabs as readonly string[]).includes(initialTab ?? "") ? (initialTab as Tab) : "Feed");

  const [feedSort, setFeedSort] = useState<"terbaru" | "populer">("terbaru");
  const [feedFilterModalOpen, setFeedFilterModalOpen] = useState(false);
  const [topicFilter, setTopicFilter] = useState(searchParams.get("topic"));
  const [feedSearchQuery, setFeedSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Search hits the server, so it is debounced rather than fired per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(feedSearchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [feedSearchQuery]);

  /** Keeps the URL in step so a filtered feed can be linked and reloaded. */
  const applyTopicFilter = (topic: string | null) => {
    setTopicFilter(topic);
    const next = new URLSearchParams(searchParams);
    if (topic) next.set("topic", topic); else next.delete("topic");
    setSearchParams(next, { replace: true });
  };

  const clearTopicFilter = () => applyTopicFilter(null);

  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSent, setInviteSent] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const sendInvite = () => {
    if (!inviteEmail.trim()) return;
    setInviteSent(true);
    setTimeout(() => {
      setInviteModalOpen(false);
      setInviteSent(false);
      setInviteEmail("");
    }, 1200);
  };

  const shareCommunityLink = () => {
    navigator.clipboard?.writeText(`${window.location.origin}/community/${id}`).catch(() => {});
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  };

  // ---- data -------------------------------------------------------------
  const communityQ = useApi(() => api.communities.detail(id), [id]);
  const community = communityQ.data;
  const isAdmin = community?.isAdmin ?? false;

  const feedQ = useApi(
    () => (tab === "Feed"
      ? api.communities.feed(id, {
          q: debouncedQuery || undefined,
          topic: topicFilter ?? undefined,
          sort: feedSort,
        })
      : Promise.resolve(null)),
    [id, tab, debouncedQuery, topicFilter, feedSort],
  );

  const materiQ = useApi(() => (tab === "Materi" ? api.communities.materi(id) : Promise.resolve(null)), [id, tab]);
  const membersQ = useApi(() => (tab === "Anggota" ? api.communities.members(id) : Promise.resolve(null)), [id, tab]);
  const eventsQ = useApi(() => (tab === "Kegiatan" || tab === "Feed" ? api.communities.events(id) : Promise.resolve(null)), [id, tab]);
  const announcementsQ = useApi(() => (tab === "Pengumuman" ? api.communities.announcements(id) : Promise.resolve(null)), [id, tab]);
  const documentsQ = useApi(() => (tab === "Dokumen" ? api.communities.documents(id) : Promise.resolve(null)), [id, tab]);
  const serverTopicsQ = useApi(() => api.communities.topics(id).catch(() => [] as ApiTopic[]), [id]);

  const posts = feedQ.data ?? [];

  // Tag options grow monotonically: server filtering narrows the posts, so
  // deriving the list purely from the current page would make options vanish
  // as soon as one was picked.
  const [topicOptions, setTopicOptions] = useState<string[]>([]);
  const addTopicOption = (value: string) =>
    setTopicOptions((prev) => (prev.includes(value) ? prev : [...prev, value]));

  useEffect(() => {
    const incoming = (serverTopicsQ.data ?? []).map((t) => t.name).filter(Boolean);
    if (incoming.length === 0) return;
    setTopicOptions((prev) => {
      const merged = new Set([...prev, ...incoming]);
      return merged.size === prev.length ? prev : Array.from(merged);
    });
  }, [serverTopicsQ.data]);

  const [syllabusOptions, setSyllabusOptions] = useState<string[]>([]);
  const addSyllabusOption = (value: string) =>
    setSyllabusOptions((prev) => (prev.includes(value) ? prev : [...prev, value]));

  useEffect(() => {
    const titles = (materiQ.data ?? []).map((s) => s.title);
    if (titles.length === 0) return;
    setSyllabusOptions((prev) => {
      const merged = new Set([...prev, ...titles]);
      return merged.size === prev.length ? prev : Array.from(merged);
    });
  }, [materiQ.data]);

  // ---- mutations --------------------------------------------------------
  const [editorState, setEditorState] = useState<{ mode: "create" | "edit"; post?: ApiPost; defaultType?: ApiPostType } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleSaved = (post: ApiPost) => {
    if (post.topic) addTopicOption(post.topic);
    if (post.syllabus) addSyllabusOption(post.syllabus);
    setEditorState(null);
    // Reload every list that could contain the new post. Each of these is a
    // no-op unless its tab is the active one, so this costs nothing extra.
    feedQ.reload();
    eventsQ.reload();
    announcementsQ.reload();
  };

  // ---- member removal ---------------------------------------------------
  // Only the owner may remove anyone; the server enforces it too, this just
  // decides whether the control is worth rendering.
  const isOwner = community?.role === "owner";
  const [removing, setRemoving] = useState<ApiMember | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const confirmRemove = async () => {
    if (!removing) return;
    setActionError(null);
    setRemoveBusy(true);
    try {
      await api.communities.removeMember(id, removing.userId);
      setRemoving(null);
      membersQ.reload();
      // The member count in the header drops, so the community itself is stale.
      communityQ.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Gagal mengeluarkan anggota");
      setRemoving(null);
    } finally {
      setRemoveBusy(false);
    }
  };

  // ---- post removal -----------------------------------------------------
  // One flow for every post type. An announcement is a post, so the Feed and the
  // Pengumuman tab share this rather than each carrying their own confirm.
  const [removingPost, setRemovingPost] = useState<ApiPost | null>(null);
  const [postBusy, setPostBusy] = useState(false);

  const confirmRemovePost = async () => {
    if (!removingPost) return;
    setActionError(null);
    setPostBusy(true);
    try {
      await api.posts.remove(removingPost.id);
      setRemovingPost(null);
      // The post could be listed on any of these, depending on its type.
      feedQ.reload();
      eventsQ.reload();
      announcementsQ.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Gagal menghapus post");
      setRemovingPost(null);
    } finally {
      setPostBusy(false);
    }
  };

  // ---- document library -------------------------------------------------
  const [docBusy, setDocBusy] = useState(false);
  const [removingDoc, setRemovingDoc] = useState<ApiDocument | null>(null);

  /** Two steps: the file goes to /uploads, then its id is published as a document. */
  const uploadDocument = async (picked: File | undefined) => {
    if (!picked) return;
    setActionError(null);
    setDocBusy(true);
    try {
      const upload = await api.uploads.upload(picked);
      await api.communities.addDocument(id, { uploadId: upload.id });
      documentsQ.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Gagal mengunggah dokumen");
    } finally {
      setDocBusy(false);
    }
  };

  const confirmRemoveDoc = async () => {
    if (!removingDoc) return;
    setActionError(null);
    setDocBusy(true);
    try {
      await api.communities.removeDocument(removingDoc.id);
      setRemovingDoc(null);
      documentsQ.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Gagal menghapus dokumen");
      setRemovingDoc(null);
    } finally {
      setDocBusy(false);
    }
  };

  // ---- materi authoring -------------------------------------------------
  const [materiBusy, setMateriBusy] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [itemFormFor, setItemFormFor] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [removingGroup, setRemovingGroup] = useState<{ id: string; title: string; count: number } | null>(null);
  const [removingItem, setRemovingItem] = useState<ApiSyllabusItem | null>(null);

  /** Every materi mutation shares this: clear error, run, reload, surface failure. */
  const runMateri = async (fn: () => Promise<unknown>, fallback: string) => {
    setActionError(null);
    setMateriBusy(true);
    try {
      await fn();
      materiQ.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : fallback);
    } finally {
      setMateriBusy(false);
    }
  };

  const addGroup = () => {
    const title = groupTitle.trim();
    if (!title) return;
    void runMateri(async () => {
      await api.materi.createGroup(id, title);
      setGroupTitle("");
      setAddingGroup(false);
    }, "Gagal menambah silabus");
  };

  const renameGroup = (syllabusId: string, title: string) => {
    if (!title.trim()) return;
    void runMateri(async () => {
      await api.materi.updateGroup(syllabusId, { title: title.trim() });
      setRenamingGroup(null);
    }, "Gagal mengubah silabus");
  };

  const confirmRemoveGroup = () => {
    if (!removingGroup) return;
    void runMateri(async () => {
      await api.materi.removeGroup(removingGroup.id);
      setRemovingGroup(null);
      // The deleted group may be the one on screen; drop the selection so the
      // detail pane falls back to the first remaining item.
      setSelectedContent(null);
    }, "Gagal menghapus silabus");
  };

  const addItem = (syllabusId: string, value: { title: string; type: string; duration: string }) =>
    void runMateri(async () => {
      await api.materi.createItem(syllabusId, value);
      setItemFormFor(null);
    }, "Gagal menambah materi");

  const saveItem = (itemId: string, value: { title: string; type: string; duration: string }) =>
    void runMateri(async () => {
      await api.materi.updateItem(itemId, value);
      setEditingItem(null);
    }, "Gagal mengubah materi");

  const confirmRemoveItem = () => {
    if (!removingItem) return;
    void runMateri(async () => {
      await api.materi.removeItem(removingItem.id);
      setRemovingItem(null);
      setSelectedContent(null);
    }, "Gagal menghapus materi");
  };

  const sharePost = (post: ApiPost) => {
    const path = linkForPost(post) ?? "";
    navigator.clipboard?.writeText(`${window.location.origin}/community/${id}/${path}`).catch(() => {});
  };

  const openPost = (post: ApiPost) => {
    const path = linkForPost(post);
    if (!path) return;
    navigate(path.startsWith("?") ? `/community/${id}${path}` : `/community/${id}/${path}`);
  };

  /**
   * The download route requires a Bearer token, which a plain <a href> cannot
   * send — so the file is fetched with auth and handed to the browser as a blob.
   */
  const downloadDocument = async (doc: ApiDocument) => {
    setActionError(null);
    try {
      const token = tokenStore.get();
      const res = await fetch(api.uploads.downloadDocument(doc.id), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error("Berkas dokumen tidak tersedia");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Gagal mengunduh dokumen");
    }
  };

  // ---- derived ----------------------------------------------------------
  const events = eventsQ.data ?? [];

  const datedEvents = useMemo(
    () => events.map((e) => ({ post: e, date: parseEventDate(e.eventDate) }))
      .sort((a, b) => (a.date?.getTime() ?? Infinity) - (b.date?.getTime() ?? Infinity)),
    [events],
  );

  const calendarMonth = useMemo(() => {
    const first = datedEvents.find((e) => e.date)?.date ?? new Date();
    return { year: first.getFullYear(), month: first.getMonth() };
  }, [datedEvents]);

  const calendarCells = useMemo(
    () => buildMonthCells(calendarMonth.year, calendarMonth.month),
    [calendarMonth],
  );

  const scheduleByDay = useMemo(() => {
    const map: Record<number, ApiPost[]> = {};
    for (const { post, date } of datedEvents) {
      if (!date || date.getFullYear() !== calendarMonth.year || date.getMonth() !== calendarMonth.month) continue;
      (map[date.getDate()] ??= []).push(post);
    }
    return map;
  }, [datedEvents, calendarMonth]);

  const today = new Date();
  const todayDate = today.getFullYear() === calendarMonth.year && today.getMonth() === calendarMonth.month
    ? today.getDate() : -1;

  // "Baru" badge is derived from post age rather than a stored flag.
  const hasNewAnnouncement = posts.some(
    (p) => p.type === "pengumuman" && Date.now() - new Date(p.createdAt).getTime() < 3 * 86400_000,
  );

  const syllabi = materiQ.data ?? [];
  const [selectedContent, setSelectedContent] = useState<{ weekId: string; itemIndex: number } | null>(null);
  const selectedWeek = syllabi.find((w) => w.id === selectedContent?.weekId) ?? syllabi[0];
  const selectedItem = selectedWeek?.items[selectedContent?.itemIndex ?? 0] ?? selectedWeek?.items[0];

  const bannerText = "var(--awan)";
  const bannerOverlay = "rgba(255,255,255,0.18)";
  const bannerOverlayBorder = "rgba(255,255,255,0.4)";

  if (communityQ.loading) {
    return (
      <>
        <Header title="Komunitas" breadcrumb={[{ label: "Komunitas", to: "/discover" }]} />
        <PageContainer><StateNote loading error={null} /></PageContainer>
      </>
    );
  }

  if (communityQ.error || !community) {
    return (
      <>
        <Header title="Komunitas" breadcrumb={[{ label: "Komunitas", to: "/discover" }]} />
        <PageContainer>
          <StateNote loading={false} error={communityQ.error ?? "Komunitas tidak ditemukan"} />
        </PageContainer>
      </>
    );
  }

  return (
    <>
      <Header
        title="Komunitas"
        breadcrumb={[{ label: "Komunitas", to: "/discover" }, { label: community.name }]}
      />

      <PageContainer>
        {/* Banner */}
        <div
          className="card"
          style={{
            border: "none",
            borderRadius: 20,
            marginBottom: 9,
            padding: 24,
            overflow: "hidden",
            background: "linear-gradient(120deg, var(--langit), var(--langit-dark))",
            color: bannerText,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div
              style={{
                width: 72, height: 72, borderRadius: 18, background: bannerOverlay,
                border: `3px solid ${bannerOverlayBorder}`, display: "flex", alignItems: "center", justifyContent: "center",
                color: bannerText, fontFamily: "var(--font-display)", fontSize: 26, fontWeight: 700, flexShrink: 0,
              }}
            >
              {community.name.charAt(0)}
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2 style={{ fontSize: 22, fontWeight: 700, color: bannerText }}>{community.name}</h2>
                {community.isLive && (
                  <button
                    onClick={() => navigate(`/live/${community.id}`)}
                    className="live-badge"
                    style={{ border: "none", cursor: "pointer" }}
                  >
                    <span className="dot"></span>SEDANG LIVE — Gabung
                  </button>
                )}
              </div>
              <p style={{ fontSize: 13.5, opacity: 0.85, marginTop: 2 }}>
                {formatCount(community.memberCount)} member · {community.category}
              </p>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              {community.isMember ? (
                <span className="badge badge-active" style={{ alignSelf: "center" }}>
                  <span className="dot"></span>{roleLabel[community.role ?? "member"]}
                </span>
              ) : (
                <button className="btn btn-primary" onClick={() => navigate(`/checkout/${community.id}`)}>
                  {community.priceCents === 0
                    ? "Gabung gratis"
                    : `Gabung — ${formatRupiah(community.priceCents)}${community.billingPeriod}`}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottom: "1px solid var(--ink-150)", marginBottom: 28 }}>
          <div style={{ display: "flex", gap: 4, overflowX: "auto" }} className="scrollbar-none">
            {tabs.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  background: "none", border: "none", padding: "12px 18px",
                  fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6,
                  color: tab === t ? "var(--langit)" : "var(--ink-500)",
                  borderBottom: tab === t ? "2px solid var(--sinyal)" : "2px solid transparent",
                  whiteSpace: "nowrap", flexShrink: 0,
                }}
              >
                {t}
                {t === "Pengumuman" && hasNewAnnouncement && (
                  <span
                    style={{
                      fontSize: 10, fontWeight: 700, color: "#fff", background: "var(--merah-senja)",
                      borderRadius: 999, padding: "1px 6px",
                    }}
                  >
                    Baru
                  </span>
                )}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexShrink: 0 }}>
            <button
              aria-label="Undang anggota"
              title="Undang anggota"
              onClick={() => setInviteModalOpen(true)}
              className="btn btn-ghost btn-icon"
              style={{ width: 36, height: 36, fontSize: 13 }}
            >
              <FontAwesomeIcon icon={faUserPlus} />
            </button>
            <button
              aria-label="Bagikan link komunitas"
              title="Bagikan link komunitas"
              onClick={shareCommunityLink}
              className="btn btn-ghost btn-icon"
              style={{ width: 36, height: 36, fontSize: 13 }}
            >
              <FontAwesomeIcon icon={linkCopied ? faCheck : faShareNodes} />
            </button>
            {community.isMember && (
              <button
                onClick={() => setEditorState({ mode: "create" })}
                className="btn btn-sm"
                style={{
                  flexShrink: 0, background: "var(--hijau-lepas)", color: "var(--awan)",
                  paddingTop: 7, paddingBottom: 7, paddingLeft: 14, paddingRight: 7,
                }}
              >
                Posting
                <span
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 18, height: 18, borderRadius: "50%", background: "rgba(255,255,255,0.25)", fontSize: 10,
                  }}
                >
                  <FontAwesomeIcon icon={faPlus} />
                </span>
              </button>
            )}
          </div>
        </div>

        {actionError && (
          <p style={{ fontSize: 13, color: "var(--merah-senja)", marginBottom: 14 }}>{actionError}</p>
        )}

        {inviteModalOpen && (
          <div
            onClick={() => setInviteModalOpen(false)}
            style={{
              position: "fixed", inset: 0, background: "rgba(22,40,58,0.4)",
              display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 20,
            }}
          >
            <div className="card" style={{ width: 380, padding: 24 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ fontSize: 16, fontWeight: 700 }}>Undang anggota</h3>
                <button
                  aria-label="Tutup"
                  onClick={() => setInviteModalOpen(false)}
                  className="btn btn-ghost btn-icon"
                  style={{ width: 28, height: 28, fontSize: 12 }}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </button>
              </div>

              <label style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-500)", display: "block", marginBottom: 6 }}>
                Email
              </label>
              <input
                className="input"
                type="email"
                placeholder="nama@email.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendInvite()}
                style={{ marginBottom: 16 }}
              />

              <button className="btn btn-primary btn-block" onClick={sendInvite} disabled={!inviteEmail.trim()}>
                {inviteSent ? <><FontAwesomeIcon icon={faCheck} /> Undangan terkirim</> : "Kirim undangan"}
              </button>
            </div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: tab === "Feed" ? "1fr 300px" : "1fr", gap: 20, paddingBottom: 60 }}>
          {/* Main column */}
          <div>
            {tab === "Feed" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {/* Pencarian + filter & sortir */}
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    className="input"
                    placeholder="Cari diskusi, topik, atau penulis..."
                    value={feedSearchQuery}
                    onChange={(e) => setFeedSearchQuery(e.target.value)}
                    style={{ flex: 1, background: "var(--awan)" }}
                  />
                  <button
                    aria-label="Filter topik"
                    title="Filter topik"
                    onClick={() => setFeedFilterModalOpen(true)}
                    className="btn btn-ghost btn-icon"
                    style={{ width: 32, height: 32, fontSize: 13, position: "relative", color: "var(--ink-500)" }}
                  >
                    <FontAwesomeIcon icon={faFilter} />
                    {topicFilter && (
                      <span style={{ position: "absolute", top: 4, right: 4, width: 6, height: 6, borderRadius: "50%", background: "var(--sinyal)" }} />
                    )}
                  </button>
                  <button
                    aria-label="Sortir"
                    title="Sortir"
                    onClick={() => setFeedFilterModalOpen(true)}
                    className="btn btn-ghost btn-icon"
                    style={{ width: 32, height: 32, fontSize: 13, position: "relative", color: "var(--ink-500)" }}
                  >
                    <FontAwesomeIcon icon={faArrowUpWideShort} />
                    {feedSort !== "terbaru" && (
                      <span style={{ position: "absolute", top: 4, right: 4, width: 6, height: 6, borderRadius: "50%", background: "var(--sinyal)" }} />
                    )}
                  </button>
                </div>

                {topicFilter && (
                  <span className="badge badge-neutral" style={{ display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
                    Topik: #{topicFilter}
                    <button
                      aria-label="Hapus filter topik"
                      onClick={clearTopicFilter}
                      style={{ background: "none", border: "none", cursor: "pointer", display: "flex", color: "inherit" }}
                    >
                      <FontAwesomeIcon icon={faXmark} />
                    </button>
                  </span>
                )}

                <StateNote
                  loading={feedQ.loading}
                  error={feedQ.error}
                  empty={!feedQ.loading && !feedQ.error && posts.length === 0}
                  emptyText="Tidak ada diskusi yang cocok dengan filter ini."
                />

                {posts.map((p) => (
                  <FeedPostCard
                    key={p.id}
                    post={p}
                    // Mirrors AccessPolicy.canManagePost on the server, which is
                    // the actual authority — this only hides controls that would 403.
                    canManage={canManagePost(p, isAdmin, user?.id)}
                    onOpen={() => openPost(p)}
                    onEdit={() => setEditorState({ mode: "edit", post: p })}
                    onDelete={() => setRemovingPost(p)}
                    onTopicClick={applyTopicFilter}
                    onShare={() => sharePost(p)}
                  />
                ))}
              </div>
            )}

            {editorState && (
              <PostEditorModal
                mode={editorState.mode}
                communityId={id}
                isAdmin={isAdmin}
                initial={editorState.post}
                defaultType={editorState.defaultType}
                topicOptions={topicOptions}
                onAddTopic={addTopicOption}
                syllabusOptions={syllabusOptions}
                onAddSyllabus={addSyllabusOption}
                onClose={() => setEditorState(null)}
                onSaved={handleSaved}
              />
            )}

            {removing && (
              <ConfirmDialog
                title={`Keluarkan ${removing.name}?`}
                subtitle={`${roleLabel[removing.role] ?? removing.role} · bergabung ${timeAgo(removing.joinedAt)}`}
                confirmLabel="Ya, keluarkan"
                busyLabel="Mengeluarkan…"
                busy={removeBusy}
                onCancel={() => setRemoving(null)}
                onConfirm={confirmRemove}
              >
                <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-700)" }}>
                  {removing.name} akan langsung kehilangan akses ke komunitas ini, dan langganannya
                  dibatalkan. Riwayat keanggotaannya tetap tersimpan dan akan tercatat sebagai churn
                  di dashboard.
                </p>
                <p style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--ink-500)", marginTop: 10 }}>
                  Kalau mau bergabung lagi, dia harus berlangganan ulang.
                </p>
              </ConfirmDialog>
            )}

            {removingPost && (
              <ConfirmDialog
                title={`Hapus ${postTypeLabel[removingPost.type] ?? "post"} ini?`}
                subtitle={`${removingPost.authorName} · ${timeAgo(removingPost.createdAt)}`}
                busy={postBusy}
                onCancel={() => setRemovingPost(null)}
                onConfirm={confirmRemovePost}
              >
                <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{removingPost.title}</p>
                <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-700)" }}>
                  Post ini akan dihapus dari komunitas dan tidak bisa dikembalikan.
                  Komentar dan lampiran yang menyertainya ikut terhapus.
                </p>
              </ConfirmDialog>
            )}

            {removingDoc && (
              <ConfirmDialog
                title={`Hapus ${removingDoc.name}?`}
                subtitle={`${formatBytes(removingDoc.sizeBytes)} · ditambahkan ${timeAgo(removingDoc.createdAt)}`}
                busy={docBusy}
                onCancel={() => setRemovingDoc(null)}
                onConfirm={confirmRemoveDoc}
              >
                <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-700)" }}>
                  Dokumen ini akan hilang dari perpustakaan komunitas dan anggota tidak bisa
                  mengunduhnya lagi. Riwayat unduhannya juga ikut terhapus dari dashboard.
                </p>
              </ConfirmDialog>
            )}

            {removingGroup && (
              <ConfirmDialog
                title={`Hapus silabus "${removingGroup.title}"?`}
                busy={materiBusy}
                onCancel={() => setRemovingGroup(null)}
                onConfirm={confirmRemoveGroup}
              >
                <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-700)" }}>
                  {removingGroup.count > 0
                    ? `${removingGroup.count} materi di dalamnya ikut terhapus, termasuk soal kuisnya.`
                    : "Silabus ini masih kosong, jadi tidak ada materi yang ikut terhapus."}
                </p>
              </ConfirmDialog>
            )}

            {removingItem && (
              <ConfirmDialog
                title={`Hapus materi "${removingItem.title}"?`}
                subtitle={MATERI_TYPES.find((t) => t.value === removingItem.type)?.label ?? removingItem.type}
                busy={materiBusy}
                onCancel={() => setRemovingItem(null)}
                onConfirm={confirmRemoveItem}
              >
                <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-700)" }}>
                  {removingItem.type === "quiz"
                    ? "Semua soal dan pilihan jawaban di materi ini ikut terhapus."
                    : "Materi ini akan hilang dari silabus dan anggota tidak bisa membukanya lagi."}
                </p>
              </ConfirmDialog>
            )}

            {feedFilterModalOpen && (
              <div
                onClick={() => setFeedFilterModalOpen(false)}
                style={{
                  position: "fixed", inset: 0, background: "rgba(22,40,58,0.4)",
                  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
                }}
              >
                <div className="card" style={{ width: 320, padding: 24 }} onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 700 }}>Filter &amp; Sortir</h3>
                    <button
                      aria-label="Tutup"
                      onClick={() => setFeedFilterModalOpen(false)}
                      className="btn btn-ghost btn-icon"
                      style={{ width: 28, height: 28, fontSize: 12 }}
                    >
                      <FontAwesomeIcon icon={faXmark} />
                    </button>
                  </div>

                  <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-500)", marginBottom: 8 }}>Topik</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 22 }}>
                    {["Semua", ...topicOptions].map((t) => {
                      const active = (topicFilter ?? "Semua") === t;
                      return (
                        <button
                          key={t}
                          onClick={() => applyTopicFilter(t === "Semua" ? null : t)}
                          className="btn btn-sm"
                          style={{
                            background: active ? "var(--langit)" : "var(--surface)",
                            color: active ? "var(--awan)" : "var(--ink-700)",
                            border: active ? "none" : "1px solid var(--ink-150)",
                          }}
                        >
                          {t}
                        </button>
                      );
                    })}
                  </div>

                  <p style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-500)", marginBottom: 8 }}>Urutkan</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 22 }}>
                    {([{ v: "terbaru", label: "Terbaru" }, { v: "populer", label: "Terpopuler" }] as const).map((opt) => (
                      <label key={opt.v} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                        <input type="radio" name="feedSort" checked={feedSort === opt.v} onChange={() => setFeedSort(opt.v)} />
                        {opt.label}
                      </label>
                    ))}
                  </div>

                  <button className="btn btn-primary btn-block" onClick={() => setFeedFilterModalOpen(false)}>Terapkan</button>
                </div>
              </div>
            )}

            {tab === "Materi" && (
              <>
                <StateNote
                  loading={materiQ.loading}
                  error={materiQ.error}
                  // Admins get the "Tambah silabus" affordance instead of a dead end.
                  empty={!materiQ.loading && !materiQ.error && syllabi.length === 0 && !isAdmin}
                  emptyText="Belum ada materi di komunitas ini."
                />

                {!materiQ.loading && !materiQ.error && (syllabi.length > 0 || isAdmin) && (
                  <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 20, alignItems: "start" }}>
                    {/* Menu konten */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                      {syllabi.map((week) => (
                        <div key={week.id} className="card" style={{ padding: 16 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
                            {renamingGroup === week.id ? (
                              <input
                                className="input" autoFocus value={groupTitle}
                                onChange={(e) => setGroupTitle(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") renameGroup(week.id, groupTitle);
                                  if (e.key === "Escape") setRenamingGroup(null);
                                }}
                                onBlur={() => renameGroup(week.id, groupTitle)}
                                style={{ fontSize: 13, padding: "5px 8px" }}
                              />
                            ) : (
                              <>
                                <h4 style={{ fontSize: 14, fontWeight: 600 }}>{week.title}</h4>
                                <span style={{ fontSize: 12, color: "var(--ink-500)", flexShrink: 0 }}>{week.items.length} materi</span>
                              </>
                            )}
                          </div>

                          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                            {week.items.map((item, i) => {
                              const isSelected = selectedWeek?.id === week.id && (selectedContent?.itemIndex ?? 0) === i;
                              if (editingItem === item.id) {
                                return (
                                  <MateriItemForm
                                    key={item.id} initial={item} busy={materiBusy}
                                    onSubmit={(value) => saveItem(item.id, value)}
                                    onCancel={() => setEditingItem(null)}
                                  />
                                );
                              }
                              return (
                                // The row is a flex wrapper, not a <button>: the admin
                                // actions cannot be nested inside the select button.
                                <div
                                  key={item.id}
                                  style={{
                                    display: "flex", alignItems: "center", borderRadius: 10,
                                    background: isSelected ? "var(--awan)" : "transparent",
                                  }}
                                >
                                  <button
                                    onClick={() => setSelectedContent({ weekId: week.id, itemIndex: i })}
                                    style={{
                                      flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10,
                                      textAlign: "left", padding: "9px 10px", borderRadius: 10,
                                      border: "none", background: "transparent",
                                      color: isSelected ? "var(--langit)" : "var(--ink-700)",
                                    }}
                                  >
                                    <span style={{ fontSize: 13, flexShrink: 0 }}>
                                      <FontAwesomeIcon icon={typeIcon[item.type] ?? faFile} />
                                    </span>
                                    <span style={{ flex: 1, fontSize: 13, fontWeight: isSelected ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {item.title}
                                    </span>
                                    <span style={{ fontSize: 11, color: "var(--ink-500)", flexShrink: 0 }}>{item.duration}</span>
                                  </button>
                                  {isAdmin && (
                                    <span style={{ display: "flex", gap: 2, paddingRight: 6, flexShrink: 0 }}>
                                      <button
                                        title="Ubah materi" disabled={materiBusy}
                                        onClick={() => { setEditingItem(item.id); setItemFormFor(null); }}
                                        style={{ border: "none", background: "transparent", color: "var(--ink-500)", fontSize: 11, padding: 4 }}
                                      >
                                        <FontAwesomeIcon icon={faPen} />
                                      </button>
                                      <button
                                        title="Hapus materi" disabled={materiBusy}
                                        onClick={() => setRemovingItem(item)}
                                        style={{ border: "none", background: "transparent", color: "var(--merah-senja)", fontSize: 11, padding: 4 }}
                                      >
                                        <FontAwesomeIcon icon={faTrash} />
                                      </button>
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                            {week.items.length === 0 && editingItem === null && itemFormFor !== week.id && (
                              <p style={{ fontSize: 12.5, color: "var(--ink-500)", padding: "6px 2px" }}>Belum ada materi.</p>
                            )}
                          </div>

                          {isAdmin && (itemFormFor === week.id ? (
                            <MateriItemForm
                              busy={materiBusy}
                              onSubmit={(value) => addItem(week.id, value)}
                              onCancel={() => setItemFormFor(null)}
                            />
                          ) : (
                            <div style={{ display: "flex", gap: 4, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--ink-150)" }}>
                              <button
                                className="btn btn-ghost btn-sm" disabled={materiBusy}
                                onClick={() => { setItemFormFor(week.id); setEditingItem(null); }}
                              >
                                <FontAwesomeIcon icon={faPlus} /> Materi
                              </button>
                              <button
                                className="btn btn-ghost btn-sm" disabled={materiBusy}
                                onClick={() => { setRenamingGroup(week.id); setGroupTitle(week.title); }}
                              >
                                <FontAwesomeIcon icon={faPen} />
                              </button>
                              <button
                                className="btn btn-ghost btn-sm" disabled={materiBusy}
                                onClick={() => setRemovingGroup({ id: week.id, title: week.title, count: week.items.length })}
                                style={{ color: "var(--merah-senja)" }}
                              >
                                <FontAwesomeIcon icon={faTrash} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ))}

                      {isAdmin && (addingGroup ? (
                        <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                          <input
                            className="input" autoFocus placeholder="Judul silabus, mis. Minggu 1 — Dasar"
                            value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") addGroup();
                              if (e.key === "Escape") { setAddingGroup(false); setGroupTitle(""); }
                            }}
                            style={{ fontSize: 13 }}
                          />
                          <div style={{ display: "flex", gap: 6 }}>
                            <button className="btn btn-secondary btn-sm" disabled={materiBusy || !groupTitle.trim()} onClick={addGroup}>
                              Simpan
                            </button>
                            <button className="btn btn-ghost btn-sm" disabled={materiBusy} onClick={() => { setAddingGroup(false); setGroupTitle(""); }}>
                              Batal
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          className="btn btn-secondary btn-sm" disabled={materiBusy}
                          onClick={() => { setAddingGroup(true); setGroupTitle(""); setRenamingGroup(null); }}
                        >
                          <FontAwesomeIcon icon={faPlus} /> Tambah silabus
                        </button>
                      ))}
                    </div>

                    {/* Detail isi konten */}
                    {!selectedWeek || !selectedItem ? (
                      <div className="card" style={{ padding: 36, textAlign: "center" }}>
                        <p style={{ fontSize: 13.5, color: "var(--ink-500)" }}>
                          {syllabi.length === 0
                            ? "Mulai dengan menambah silabus, lalu isi materinya."
                            : "Pilih materi di sebelah kiri untuk melihat isinya."}
                        </p>
                      </div>
                    ) : (
                    <div className="card" style={{ padding: 24 }}>
                      <MateriPlayer item={selectedItem} isAdmin={isAdmin} />
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <span className="badge badge-neutral">{selectedWeek.title}</span>
                        <span style={{ fontSize: 12, color: "var(--ink-500)" }}>{selectedItem.duration}</span>
                      </div>
                      <h3 style={{ fontSize: 18, fontWeight: 700 }}>{selectedItem.title}</h3>
                    </div>
                    )}
                  </div>
                )}
              </>
            )}

            {tab === "Kegiatan" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                {/* Outside the events.length check on purpose: without an entry
                    point here, a community with no events yet is a dead end. */}
                {isAdmin && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 600 }}>
                      Kegiatan
                      {events.length > 0 && (
                        <span style={{ color: "var(--ink-500)", fontWeight: 400 }}> · {events.length} terjadwal</span>
                      )}
                    </h3>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setEditorState({ mode: "create", defaultType: "event" })}
                    >
                      <FontAwesomeIcon icon={faPlus} /> Tambah kegiatan
                    </button>
                  </div>
                )}

                <StateNote
                  loading={eventsQ.loading}
                  error={eventsQ.error}
                  empty={!eventsQ.loading && !eventsQ.error && events.length === 0}
                  emptyText="Belum ada kegiatan terjadwal."
                />

                {events.length > 0 && (
                  <>
                    {/* Grid kalender bulanan */}
                    <div className="card" style={{ padding: 18 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                        <h4 style={{ fontSize: 15, fontWeight: 600 }}>
                          {MONTHS_ID[calendarMonth.month]} {calendarMonth.year}
                        </h4>
                        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--ink-500)" }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--merah-senja)", flexShrink: 0 }} />
                          Kegiatan
                        </span>
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(7, 1fr)",
                          gap: 1,
                          background: "var(--border)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        {weekdayLabels.map((d) => (
                          <div
                            key={d}
                            style={{
                              textAlign: "center", fontSize: 11.5, fontWeight: 600, color: "var(--ink-500)",
                              padding: "6px 0", background: "var(--awan)",
                            }}
                          >
                            {d}
                          </div>
                        ))}
                        {calendarCells.map((day, i) => {
                          const items = day ? scheduleByDay[day] ?? [] : [];
                          const isToday = day === todayDate;
                          return (
                            <div
                              key={i}
                              style={{
                                minHeight: 78, minWidth: 0, padding: 6,
                                background: isToday ? "var(--awan)" : "var(--surface)",
                                boxShadow: isToday ? "inset 0 0 0 1.5px var(--sinyal)" : "none",
                              }}
                            >
                              {day && (
                                <>
                                  <div style={{ fontSize: 12, fontWeight: isToday ? 700 : 500, color: isToday ? "var(--sinyal)" : "var(--ink-700)", marginBottom: 4 }}>
                                    {day}
                                  </div>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                    {items.slice(0, 2).map((it) => (
                                      <div
                                        key={it.id}
                                        title={it.title}
                                        onClick={() => navigate(`/community/${community.id}/event/${it.id}`)}
                                        style={{
                                          fontSize: 9.5, fontWeight: 600, color: "#fff", background: "var(--merah-senja)",
                                          borderRadius: 4, padding: "1px 4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                          cursor: "pointer",
                                        }}
                                      >
                                        {it.title}
                                      </div>
                                    ))}
                                    {items.length > 2 && (
                                      <div style={{ fontSize: 9.5, color: "var(--ink-500)" }}>+{items.length - 2} lagi</div>
                                    )}
                                  </div>
                                </>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Agenda mendatang */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {datedEvents.map(({ post, date }) => (
                        <div
                          key={post.id}
                          onClick={() => navigate(`/community/${community.id}/event/${post.id}`)}
                          className="card card-clickable"
                          style={{ padding: 16, display: "flex", alignItems: "center", gap: 16 }}
                        >
                          <div style={{ width: 52, textAlign: "center", flexShrink: 0 }}>
                            {date ? (
                              <>
                                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sinyal)" }}>{MONTHS_ID[date.getMonth()]}</div>
                                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--langit)" }}>{date.getDate()}</div>
                                <div style={{ fontSize: 10.5, color: "var(--ink-500)" }}>{WEEKDAYS_ID[date.getDay()]}</div>
                              </>
                            ) : (
                              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-500)" }}>{post.eventDate ?? "—"}</div>
                            )}
                          </div>
                          <div style={{ flex: 1 }}>
                            <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{post.title}</p>
                            <p style={{ fontSize: 12.5, color: "var(--ink-500)" }}>{post.eventTime ?? ""}</p>
                          </div>
                          <span className="badge badge-churn">
                            <FontAwesomeIcon icon={faCalendarDay} /> Kegiatan
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {tab === "Pengumuman" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {/* Outside the list on purpose: with no announcements yet, this
                    is the only way in. */}
                {isAdmin && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 600 }}>
                      Pengumuman
                      {(announcementsQ.data ?? []).length > 0 && (
                        <span style={{ color: "var(--ink-500)", fontWeight: 400 }}>
                          {" "}· {(announcementsQ.data ?? []).length} dipublikasikan
                        </span>
                      )}
                    </h3>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setEditorState({ mode: "create", defaultType: "pengumuman" })}
                    >
                      <FontAwesomeIcon icon={faPlus} /> Tambah pengumuman
                    </button>
                  </div>
                )}

                <StateNote
                  loading={announcementsQ.loading}
                  error={announcementsQ.error}
                  empty={!announcementsQ.loading && !announcementsQ.error && (announcementsQ.data ?? []).length === 0}
                  emptyText="Belum ada pengumuman."
                />

                {(announcementsQ.data ?? []).map((a) => {
                  const isNew = Date.now() - new Date(a.createdAt).getTime() < 3 * 86400_000;
                  return (
                    <div
                      key={a.id}
                      onClick={() => navigate(`/community/${community.id}/announcement/${a.id}`)}
                      className="card card-clickable"
                      style={{ padding: 20, position: "relative" }}
                    >
                      {isNew && (
                        <span className="badge badge-pending" style={{ position: "absolute", top: 14, right: 14 }}>
                          Baru
                        </span>
                      )}
                      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, paddingRight: 60 }}>
                        <span style={{ color: "var(--sinyal)" }}>
                          <FontAwesomeIcon icon={faBullhorn} />
                        </span>
                        <p style={{ fontSize: 15, fontWeight: 600 }}>{a.title}</p>
                      </div>
                      <p style={{ fontSize: 13.5, color: "var(--ink-700)", lineHeight: 1.55, marginBottom: 10 }}>{a.body}</p>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                        <p style={{ fontSize: 12, color: "var(--ink-500)" }}>{a.authorName} · {timeAgo(a.createdAt)}</p>
                        {isAdmin && (
                          <button
                            aria-label={`Hapus pengumuman ${a.title}`}
                            title="Hapus pengumuman"
                            // The whole card navigates, so this must not bubble.
                            onClick={(e) => { e.stopPropagation(); setRemovingPost(a); }}
                            className="btn btn-ghost btn-icon"
                            style={{ color: "var(--merah-senja)", flexShrink: 0 }}
                          >
                            <FontAwesomeIcon icon={faTrash} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {tab === "Dokumen" && (
              <>
                {/* Outside the list check: an empty library needs a way in too. */}
                {isAdmin && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 14 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 600 }}>
                      Dokumen
                      {(documentsQ.data ?? []).length > 0 && (
                        <span style={{ color: "var(--ink-500)", fontWeight: 400 }}>
                          {" "}· {(documentsQ.data ?? []).length} berkas
                        </span>
                      )}
                    </h3>
                    <label className="btn btn-primary btn-sm" style={{ cursor: docBusy ? "default" : "pointer" }}>
                      <FontAwesomeIcon icon={faUpload} />
                      {docBusy ? " Mengunggah…" : " Unggah dokumen"}
                      <input
                        type="file" hidden disabled={docBusy}
                        onChange={(e) => { void uploadDocument(e.target.files?.[0]); e.target.value = ""; }}
                      />
                    </label>
                  </div>
                )}

                <StateNote
                  loading={documentsQ.loading}
                  error={documentsQ.error}
                  empty={!documentsQ.loading && !documentsQ.error && (documentsQ.data ?? []).length === 0}
                  emptyText="Belum ada dokumen."
                />

                {(documentsQ.data ?? []).length > 0 && (
                  <div className="card" style={{ padding: 8 }}>
                    {(documentsQ.data ?? []).map((f, i, arr) => (
                      <div
                        key={f.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 14,
                          padding: "14px 14px", borderBottom: i < arr.length - 1 ? "1px solid var(--ink-100)" : "none",
                        }}
                      >
                        <span style={{ fontSize: 18, color: "var(--ink-500)", flexShrink: 0 }}>
                          <FontAwesomeIcon icon={libraryTypeIcon[f.type] ?? faFile} />
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</p>
                          <p style={{ fontSize: 12, color: "var(--ink-500)" }}>{formatBytes(f.sizeBytes)} · {timeAgo(f.createdAt)}</p>
                        </div>
                        <button
                          aria-label="Unduh"
                          title="Unduh"
                          onClick={() => downloadDocument(f)}
                          className="btn btn-ghost btn-icon"
                        >
                          <FontAwesomeIcon icon={faDownload} />
                        </button>
                        {isAdmin && (
                          <button
                            aria-label={`Hapus ${f.name}`}
                            title={`Hapus ${f.name}`}
                            disabled={docBusy}
                            onClick={() => setRemovingDoc(f)}
                            className="btn btn-ghost btn-icon"
                            style={{ color: "var(--merah-senja)" }}
                          >
                            <FontAwesomeIcon icon={faTrash} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {tab === "Anggota" && (
              <>
                <StateNote
                  loading={membersQ.loading}
                  error={membersQ.error}
                  empty={!membersQ.loading && !membersQ.error && (membersQ.data ?? []).length === 0}
                  emptyText="Belum ada anggota."
                />

                {(membersQ.data ?? []).length > 0 && (
                  <div className="card" style={{ padding: 8 }}>
                    {(membersQ.data ?? []).map((m, i, arr) => (
                      <div
                        key={m.userId}
                        style={{
                          display: "flex", justifyContent: "space-between", alignItems: "center",
                          padding: "14px 14px", borderBottom: i < arr.length - 1 ? "1px solid var(--ink-100)" : "none",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <Avatar initials={initialsOf(m.name)} />
                          <div>
                            <p style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</p>
                            <p style={{ fontSize: 12.5, color: "var(--ink-500)" }}>
                              {roleLabel[m.role] ?? m.role} · {m.status === "churned" && m.endedAt
                                ? `Berakhir ${timeAgo(m.endedAt)}`
                                : timeAgo(m.joinedAt)}
                            </p>
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span className={`badge ${statusBadge[m.status]}`}>
                            <span className="dot"></span>{statusLabel[m.status]}
                          </span>
                          <button
                            aria-label={`Chat dengan ${m.name}`}
                            title={`Chat dengan ${m.name}`}
                            onClick={() => openMemberChat(m.userId, m.name)}
                            className="btn btn-ghost btn-icon"
                            style={{ width: 32, height: 32, fontSize: 13, color: "var(--ink-500)" }}
                          >
                            <FontAwesomeIcon icon={faComment} />
                          </button>
                          {/* The owner cannot be removed, and someone who has
                              already left has nothing left to remove. */}
                          {isOwner && m.role !== "owner" && m.status !== "churned" && (
                            <button
                              aria-label={`Keluarkan ${m.name}`}
                              title={`Keluarkan ${m.name} dari komunitas`}
                              onClick={() => setRemoving(m)}
                              className="btn btn-ghost btn-icon"
                              style={{ width: 32, height: 32, fontSize: 13, color: "var(--merah-senja)" }}
                            >
                              <FontAwesomeIcon icon={faUserMinus} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Sidebar — cuma tampil di tab Feed */}
          {tab === "Feed" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div className="card" style={{ padding: 18 }}>
                <h4 style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 6, color: "var(--ink-700)" }}>Tentang komunitas</h4>
                <p style={{ fontSize: 13, color: "var(--ink-500)", lineHeight: 1.55 }}>{community.description}</p>
              </div>

              <div className="card" style={{ padding: 18 }}>
                <h4 style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 12, color: "var(--ink-700)" }}>Event mendatang</h4>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {datedEvents.length === 0 && (
                    <p style={{ fontSize: 12.5, color: "var(--ink-500)" }}>Belum ada event.</p>
                  )}
                  {datedEvents.slice(0, 3).map(({ post, date }) => (
                    <div
                      key={post.id}
                      onClick={() => navigate(`/community/${community.id}/event/${post.id}`)}
                      style={{ display: "flex", gap: 12, cursor: "pointer" }}
                    >
                      <div style={{ width: 40, textAlign: "center", flexShrink: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sinyal)" }}>
                          {date ? MONTHS_ID[date.getMonth()] : ""}
                        </div>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--langit)" }}>
                          {date ? date.getDate() : "—"}
                        </div>
                      </div>
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.35 }}>{post.title}</p>
                        <p style={{ fontSize: 12, color: "var(--ink-500)" }}>{post.eventTime ?? ""}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </PageContainer>
    </>
  );
}
