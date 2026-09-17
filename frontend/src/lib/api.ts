/**
 * Typed client for the DIUDARA API. Replaces src/data/mock.ts as the source of
 * every screen's data.
 *
 * In dev VITE_API_URL points at the Bun server on :3004. In production the SPA
 * and the API share an origin, so the default "/api" needs no configuration.
 */

const BASE = import.meta.env.VITE_API_URL ?? "/api";
const TOKEN_KEY = "diudara.token";

export const tokenStore = {
  get: (): string | null => {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set: (token: string) => {
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
  },
  clear: () => {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
  },
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = tokenStore.get();
  const isForm = init.body instanceof FormData;

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = payload?.error ?? {};
    // A dead/expired token must not leave the app in a half-logged-in state.
    if (res.status === 401) tokenStore.clear();
    throw new ApiError(res.status, err.code ?? "error", err.message ?? `Request gagal (${res.status})`);
  }
  return payload as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = (path: string) => request<void>(path, { method: "DELETE" });

const qs = (params: Record<string, string | undefined>) => {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== "");
  return entries.length ? "?" + new URLSearchParams(entries as [string, string][]) : "";
};

// ------------------------------------------------------------------- types

export type ApiUser = {
  id: string; email: string; name: string;
  handle: string; avatarColor: string; initials: string;
};

export type ApiCommunity = {
  id: string; name: string; niche: string; category: string; description: string;
  color: string; priceCents: number; billingPeriod: string; ownerId: string;
  memberCount: number; isLive: boolean; liveViewers: number; trending: boolean;
};

export type ApiCommunityDetail = ApiCommunity & {
  isMember: boolean; isAdmin: boolean; role: "owner" | "admin" | "member" | null;
};

export type ApiAttachment = { id: string; name: string; kind: "image" | "video" | "audio" | "file"; url: string };

export type ApiPostType = "diskusi" | "pengumuman" | "konten" | "event" | "anggota";

export type ApiPost = {
  id: string; communityId: string; authorId: string; authorName: string;
  type: ApiPostType; tag: string; topic: string | null; title: string; body: string;
  syllabus: string | null; eventDate: string | null; eventTime: string | null;
  eventLocation: string | null; meetingUrl: string | null;
  hasLiveRoom: boolean; inviteTarget: string | null;
  createdAt: string; updatedAt: string; replies: number; attachments: ApiAttachment[];
};

export type ApiComment = {
  id: string; authorName: string; body: string; createdAt: string; likes: number;
};

export type ApiMember = {
  userId: string; name: string; role: "owner" | "admin" | "member";
  status: "active" | "pending" | "churned"; joinedAt: string; endedAt: string | null;
};

/** A true/false question is a 2-option multiple choice; this only steers the editor UI. */
export type ApiQuizFormat = "multiple_choice" | "true_false";

export type ApiQuizOption = { id: string; text: string; isCorrect: boolean };

export type ApiQuizQuestion = {
  id: string; prompt: string; format: ApiQuizFormat;
  explanation: string | null; options: ApiQuizOption[];
};

/** What a question write carries. Options replace the existing set wholesale. */
export type ApiQuestionInput = {
  prompt: string; format: ApiQuizFormat; explanation?: string | null;
  options: Array<{ text: string; isCorrect: boolean }>;
};

/** Matches SYLLABUS_ITEM_TYPES on the server; drives the icon and player chrome. */
export type ApiSyllabusItemType = "video" | "ebook" | "audio" | "quiz";

export type ApiSyllabusItem = {
  id: string; title: string; type: string; duration: string;
  /** The lesson file. Null while an item is outlined, or when it is a link instead. */
  file: ApiAttachment | null;
  /** The YouTube link as the creator pasted it. */
  sourceUrl: string | null;
  /** Derived server-side, so the client never parses a YouTube URL itself. */
  embedUrl: string | null;
};

export type ApiSyllabus = {
  id: string; title: string;
  items: ApiSyllabusItem[];
};

export type ApiDocument = {
  id: string; name: string; type: string; sizeBytes: number; createdAt: string;
};

export type ApiTier = {
  id: string; communityId: string; name: string; priceCents: number;
  billingPeriod: string; benefits: string[]; highlight: boolean;
};

export type ApiPaymentMethod = { id: string; name: string; note: string };

/** A topic is not a row — it exists while posts carry it, hence the count. */
export type ApiTopic = { name: string; count: number };

/** What the AI co-builder has gathered. Every field optional until it asks. */
export type ApiCommunityDraft = {
  name?: string;
  niche?: string;
  category?: string;
  description?: string;
  tiers?: Array<{ name: string; priceCents: number; billingPeriod?: string; benefits?: string[]; highlight?: boolean }>;
};

export type ApiBuilderMessage = { role: "user" | "assistant"; content: string };

export type ApiBuilderTurn = { reply: string; done: boolean; draft: ApiCommunityDraft };

export type ApiStats = {
  salesSummary: {
    totalRevenue: number; totalMembers: number; newMembersThisMonth: number;
    churnRate: number; successRate: number;
  };
  revenueByMonth: Array<{ month: string; value: number }>;
  tierDistribution: Array<{ name: string; pct: number; color: string }>;
  activityLog: Array<{ name: string; action: string; time: string; type: string }>;
  recentMembers: Array<{ name: string; status: "active" | "pending" | "churned"; joined: string }>;
  topDocuments: Array<{ name: string; type: string; downloads: number }>;
};

export type ApiConversation = {
  id: string; peerName: string; peerInitials: string; peerColor: string;
  lastMessage: string; lastMessageAt: string | null; unread: number;
};

export type ApiMessage = {
  id: string; sender: "me" | "them"; body: string;
  createdAt: string; attachments: ApiAttachment[];
};

export type ApiLive = {
  id: string | null; title: string | null; status: string;
  viewerCount: number; startedAt: string | null;
};

export type ApiLiveChat = { id: string; userName: string; body: string; createdAt: string };

/**
 * Ingest credentials for OBS. `streamKey` IS the broadcast credential — :1935 is
 * public — so it is admin-only and never rendered in a shareable surface.
 */
export type ApiStreamCredentials = {
  sessionId: string;
  /** Public path segment — it appears in every viewer's playback url. */
  streamKey: string;
  /** The broadcast credential. Admin-only, and the half that must never leak. */
  publishSecret: string | null;
  /** What goes in OBS's "Stream Key" field: the key with the credential as a query. */
  obsStreamKey: string;
  serverUrl: string;
  ingestUrl: string;
  status: string;
};

/** A member's permission to watch, with the url the player should load. */
export type ApiWatchToken = {
  sessionId: string; token: string; expiresInSeconds: number; playbackUrl: string;
};

// ---------------------------------------------------------------- endpoints

export const api = {
  auth: {
    register: (body: { name: string; email: string; password: string }) =>
      post<{ user: ApiUser; token: string }>("/auth/register", body),
    login: (body: { email: string; password: string }) =>
      post<{ user: ApiUser; token: string }>("/auth/login", body),
    me: () => get<ApiUser>("/auth/me"),
  },

  communities: {
    list: (params: { q?: string; category?: string; isLive?: string } = {}) =>
      get<ApiCommunity[]>(`/communities${qs(params)}`),
    detail: (id: string) => get<ApiCommunityDetail>(`/communities/${id}`),
    mine: () => get<{ joined: ApiCommunity[]; created: ApiCommunity[] }>("/me/communities"),
    categories: () => get<string[]>("/categories"),
    trendingTags: () => get<string[]>("/trending-tags"),

    feed: (id: string, params: { tag?: string; topic?: string; q?: string; sort?: string; types?: string } = {}) =>
      get<ApiPost[]>(`/communities/${id}/feed${qs(params)}`),
    announcements: (id: string) => get<ApiPost[]>(`/communities/${id}/announcements`),
    events: (id: string) => get<ApiPost[]>(`/communities/${id}/events`),
    members: (id: string) => get<ApiMember[]>(`/communities/${id}/members`),
    /** Owner-only. Ends the membership and cancels its subscription. */
    removeMember: (id: string, userId: string) =>
      request<{ ok: boolean }>(`/communities/${id}/members/${userId}`, { method: "DELETE" }),
    materi: (id: string) => get<ApiSyllabus[]>(`/communities/${id}/materi`),
    documents: (id: string) => get<ApiDocument[]>(`/communities/${id}/documents`),
    /** Admin-only. Publishes an already-uploaded file into the library. */
    addDocument: (id: string, body: { uploadId: string; name?: string }) =>
      post<ApiDocument>(`/communities/${id}/documents`, body),
    removeDocument: (documentId: string) =>
      request<{ ok: boolean }>(`/documents/${documentId}`, { method: "DELETE" }),
    topics: (id: string) => get<ApiTopic[]>(`/communities/${id}/topics`),
    /** Admin-only. Renaming onto an existing topic merges the two. */
    renameTopic: (id: string, topic: string, name: string) =>
      patch<{ ok: boolean; renamed: number; topic: string }>(
        `/communities/${id}/topics/${encodeURIComponent(topic)}`, { name },
      ),
    /** Admin-only. Detaches a topic from every post; no post is deleted. */
    deleteTopic: (id: string, topic: string) =>
      request<{ ok: boolean; cleared: number }>(
        `/communities/${id}/topics/${encodeURIComponent(topic)}`, { method: "DELETE" },
      ),
    stats: (id: string) => get<ApiStats>(`/communities/${id}/stats`),
    tiers: (id: string) => get<ApiTier[]>(`/communities/${id}/tiers`),

    create: (draft: ApiCommunityDraft) =>
      post<ApiCommunity & { tiers: ApiTier[] }>("/communities", { draft }),
  },

  /** Authoring the Materi tab. Every endpoint here is owner/admin only. */
  materi: {
    createGroup: (communityId: string, title: string) =>
      post<ApiSyllabus>(`/communities/${communityId}/materi`, { title }),
    updateGroup: (syllabusId: string, body: { title?: string; sortOrder?: number }) =>
      patch<ApiSyllabus>(`/materi/${syllabusId}`, body),
    removeGroup: (syllabusId: string) => del(`/materi/${syllabusId}`),

    // uploadId: an id from api.uploads.upload(). Pass null to detach the file.
    createItem: (syllabusId: string, body: {
      title: string; type: string; duration?: string; uploadId?: string | null; sourceUrl?: string | null;
    }) => post<ApiSyllabusItem>(`/materi/${syllabusId}/items`, body),
    updateItem: (itemId: string, body: {
      title?: string; type?: string; duration?: string; sortOrder?: number;
      uploadId?: string | null; sourceUrl?: string | null;
    }) => patch<ApiSyllabusItem>(`/materi-items/${itemId}`, body),
    removeItem: (itemId: string) => del(`/materi-items/${itemId}`),
  },

  /** Quiz questions on a materi item of type "quiz". Reading is member-level. */
  quiz: {
    list: (itemId: string) => get<ApiQuizQuestion[]>(`/materi-items/${itemId}/quiz`),
    createQuestion: (itemId: string, body: ApiQuestionInput) =>
      post<ApiQuizQuestion>(`/materi-items/${itemId}/questions`, body),
    updateQuestion: (questionId: string, body: Partial<ApiQuestionInput> & { sortOrder?: number }) =>
      patch<ApiQuizQuestion>(`/quiz-questions/${questionId}`, body),
    removeQuestion: (questionId: string) => del(`/quiz-questions/${questionId}`),
  },

  ai: {
    /**
     * One turn of the community co-builder. The whole transcript goes up each
     * time — the server keeps no session, and the OpenRouter key lives only there.
     */
    communityBuilder: (messages: ApiBuilderMessage[]) =>
      post<ApiBuilderTurn>("/ai/community-builder", { messages }),
  },

  posts: {
    create: (communityId: string, body: Partial<ApiPost> & { type: ApiPostType; title: string; attachmentIds?: string[] }) =>
      post<ApiPost>(`/communities/${communityId}/posts`, body),
    get: (postId: string) => get<ApiPost>(`/posts/${postId}`),
    update: (postId: string, body: Partial<ApiPost>) => patch<ApiPost>(`/posts/${postId}`, body),
    remove: (postId: string) => del(`/posts/${postId}`),
    comments: (postId: string) => get<ApiComment[]>(`/posts/${postId}/comments`),
    addComment: (postId: string, body: string) => post<ApiComment>(`/posts/${postId}/comments`, { body }),
    likeComment: (commentId: string) => post<{ likes: number; liked: boolean }>(`/comments/${commentId}/like`),
  },

  checkout: {
    paymentMethods: () => get<ApiPaymentMethod[]>("/payment-methods"),
    subscribe: (communityId: string, body: { tierId: string; method: string }) =>
      post<{ subscriptionId: string; status: string; redirectUrl: string | null; tier: { id: string; name: string; priceCents: number } }>(
        `/communities/${communityId}/subscriptions`, body),
  },

  chat: {
    conversations: () => get<ApiConversation[]>("/conversations"),
    open: (peerId: string) => post<{ id: string }>("/conversations", { peerId }),
    messages: (id: string) => get<ApiMessage[]>(`/conversations/${id}/messages`),
    send: (id: string, body: { text: string; attachmentIds?: string[] }) =>
      post<ApiMessage>(`/conversations/${id}/messages`, body),
    markRead: (id: string) => post<{ ok: boolean }>(`/conversations/${id}/read`),
  },

  live: {
    state: (communityId: string) => get<ApiLive>(`/communities/${communityId}/live`),
    chat: (communityId: string) => get<ApiLiveChat[]>(`/communities/${communityId}/live/chat`),
    sendChat: (communityId: string, body: string) =>
      post<{ id: string }>(`/communities/${communityId}/live/chat`, { body }),

    /** Keeps the viewer counted as present. The count is derived from these calls. */
    heartbeat: (communityId: string) =>
      post<{ ok: true }>(`/communities/${communityId}/live/heartbeat`),

    /** Members only, and only while something is on air. The url carries the token. */
    watchToken: (communityId: string) =>
      post<ApiWatchToken>(`/communities/${communityId}/live/watch-token`),

    /** Admin-only. Provisions the community's live room the first time it is asked for. */
    streamKey: (communityId: string) =>
      get<ApiStreamCredentials>(`/communities/${communityId}/live/stream-key`),
    /** Admin-only. Mints a new key; the old one cannot connect again. */
    rotateStreamKey: (communityId: string) =>
      post<ApiStreamCredentials & { endedActiveSession: boolean }>(
        `/communities/${communityId}/live/stream-key/rotate`,
      ),
  },

  uploads: {
    upload: async (file: File): Promise<ApiAttachment> => {
      const form = new FormData();
      form.append("file", file);
      return request<ApiAttachment>("/uploads", { method: "POST", body: form });
    },
    /** Absolute URL for <img>/<video> src — paths from the API are origin-relative. */
    url: (path: string) => (path.startsWith("http") ? path : path),
    downloadDocument: (documentId: string) => `${BASE}/documents/${documentId}/download`,
  },
};
