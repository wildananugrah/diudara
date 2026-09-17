/**
 * Ports. Every interface here is owned by the domain and implemented in
 * infrastructure/. Services depend on these types only — never on Drizzle, Bun,
 * or Hono — so swapping an adapter never touches a use case (DIP + OCP).
 *
 * Interfaces are deliberately narrow and per-aggregate rather than one generic
 * Repository<T>: a service that only reads posts should not be handed payment
 * methods it must ignore (ISP).
 */
import type {
  Community, Membership, MemberRole, MemberStatus, PaymentStatus,
  Post, PostType, QuizFormat, SubscriptionStatus, UploadKind, User,
} from "./types.ts";

// ---------------------------------------------------------------- identity

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
}

export interface TokenIssuer {
  sign(payload: { sub: string }): Promise<string>;
  verify(token: string): Promise<{ sub: string } | null>;
}

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<(User & { passwordHash: string }) | null>;
  create(input: {
    email: string; passwordHash: string; name: string;
    handle: string; avatarColor: string; initials: string;
  }): Promise<User>;
}

// ------------------------------------------------------------- communities

export type CommunityListItem = Community & {
  memberCount: number;
  isLive: boolean;
  liveViewers: number;
  trending: boolean;
};

export interface CommunityRepository {
  list(filter: { q?: string; category?: string; isLive?: boolean }): Promise<CommunityListItem[]>;
  findById(id: string): Promise<CommunityListItem | null>;
  listCategories(): Promise<string[]>;
  listTrendingTags(): Promise<string[]>;
  /** True if the slug is taken. Lets the caller pick a free one before inserting. */
  exists(id: string): Promise<boolean>;
  create(input: {
    id: string; name: string; niche: string; category: string; description: string;
    color: string; priceCents: number; billingPeriod: string; ownerId: string;
  }): Promise<CommunityListItem>;
}

export interface MembershipRepository {
  find(communityId: string, userId: string): Promise<Membership | null>;
  listMembers(communityId: string): Promise<
    Array<{ userId: string; name: string; role: MemberRole; status: MemberStatus; joinedAt: Date; endedAt: Date | null }>
  >;
  listForUser(userId: string): Promise<Array<{ communityId: string; role: MemberRole; status: MemberStatus }>>;
  upsert(input: {
    communityId: string; userId: string; role: MemberRole;
    status: MemberStatus; tierId: string | null;
  }): Promise<Membership>;
  /**
   * Ends a membership. Deliberately NOT a delete: the Creator Dashboard derives
   * churn rate and its activity log from churned rows, so removing the row would
   * make the member vanish from the stats instead of showing up as a churn.
   */
  markChurned(communityId: string, userId: string): Promise<void>;
}

// -------------------------------------------------------------------- feed

export type FeedFilter = {
  communityId: string;
  types?: PostType[];
  tag?: string;
  topic?: string;
  q?: string;
  sort?: "terbaru" | "populer";
};

export type PostWithMeta = Post & {
  authorName: string;
  replies: number;
  attachments: Array<{ id: string; name: string; kind: UploadKind; url: string }>;
};

export interface PostRepository {
  list(filter: FeedFilter): Promise<PostWithMeta[]>;
  findById(id: string): Promise<PostWithMeta | null>;
  create(input: Omit<Post, "id" | "createdAt" | "updatedAt"> & { attachmentIds?: string[] }): Promise<PostWithMeta>;
  update(id: string, patch: Partial<Pick<Post, "title" | "body" | "tag" | "topic" | "syllabus" | "eventDate" | "eventTime" | "eventLocation" | "meetingUrl" | "hasLiveRoom">>): Promise<PostWithMeta>;
  delete(id: string): Promise<void>;
  /** Topics in use, with how many posts carry each — a topic has no row of its own. */
  listTopics(communityId: string): Promise<Array<{ name: string; count: number }>>;
  /**
   * Clears a topic from every post carrying it, returning how many changed.
   * A topic has no row of its own — it exists only while a post references it —
   * so "deleting" one means detaching it, never deleting the posts.
   */
  clearTopic(communityId: string, topic: string): Promise<number>;
  /** Retags every post from one topic to another, returning how many changed. */
  renameTopic(communityId: string, from: string, to: string): Promise<number>;
}

export interface CommentRepository {
  listForPost(postId: string): Promise<Array<{
    id: string; authorName: string; body: string; createdAt: Date; likes: number;
  }>>;
  create(input: { postId: string; authorId: string; body: string }): Promise<{
    id: string; authorName: string; body: string; createdAt: Date; likes: number;
  }>;
  toggleLike(commentId: string, userId: string): Promise<{ likes: number; liked: boolean }>;
}

// ------------------------------------------------------- library & content

/** Same shape post/chat attachments already use, so the frontend renders it identically. */
export type Attachment = { id: string; name: string; kind: UploadKind; url: string };

export type SyllabusItem = {
  id: string; title: string; type: string; duration: string;
  /** The lesson file. Null while an item is outlined, or when it is a link instead. */
  file: Attachment | null;
  /** The YouTube link as pasted, for display and editing. */
  sourceUrl: string | null;
  /** Derived from sourceUrl so the client never has to parse YouTube URLs itself. */
  embedUrl: string | null;
};
export type SyllabusGroup = { id: string; title: string; items: SyllabusItem[] };

export interface SyllabusRepository {
  listForCommunity(communityId: string): Promise<SyllabusGroup[]>;

  /** Returns communityId so the service can authorise against the owning community. */
  findGroup(id: string): Promise<{ id: string; communityId: string; title: string } | null>;
  createGroup(input: { communityId: string; title: string }): Promise<SyllabusGroup>;
  updateGroup(id: string, patch: { title?: string; sortOrder?: number }): Promise<SyllabusGroup>;
  deleteGroup(id: string): Promise<void>;

  /** communityId is resolved through the parent group, for the same reason. */
  findItem(id: string): Promise<{ id: string; syllabusId: string; communityId: string; type: string } | null>;
  createItem(input: {
    syllabusId: string; title: string; type: string; duration: string;
    uploadId?: string | null; sourceUrl?: string | null;
  }): Promise<SyllabusItem>;
  updateItem(id: string, patch: {
    title?: string; type?: string; duration?: string; sortOrder?: number;
    uploadId?: string | null; sourceUrl?: string | null;
  }): Promise<SyllabusItem>;
  deleteItem(id: string): Promise<void>;
}

export type QuizOption = { id: string; text: string; isCorrect: boolean };
export type QuizQuestion = {
  id: string; prompt: string; format: QuizFormat;
  explanation: string | null; options: QuizOption[];
};

/**
 * Options are values, not entities: they are meaningless apart from their
 * question and are always replaced wholesale on save. That keeps the write
 * surface to three endpoints instead of six.
 */
export interface QuizRepository {
  listForItem(itemId: string): Promise<QuizQuestion[]>;
  /** Returns communityId so the service can authorise against the owning community. */
  findQuestion(id: string): Promise<{ id: string; itemId: string; communityId: string } | null>;
  createQuestion(input: {
    itemId: string; prompt: string; format: QuizFormat; explanation: string | null;
    options: Array<{ text: string; isCorrect: boolean }>;
  }): Promise<QuizQuestion>;
  updateQuestion(id: string, patch: {
    prompt?: string; format?: QuizFormat; explanation?: string | null; sortOrder?: number;
    options?: Array<{ text: string; isCorrect: boolean }>;
  }): Promise<QuizQuestion>;
  deleteQuestion(id: string): Promise<void>;
}

export interface DocumentRepository {
  listForCommunity(communityId: string): Promise<Array<{
    id: string; name: string; type: string; sizeBytes: number; createdAt: Date;
  }>>;
  findById(id: string): Promise<{ id: string; communityId: string; name: string; storageKey: string; mime: string } | null>;
  create(input: {
    communityId: string; uploadId: string; name: string; type: string; sizeBytes: number;
  }): Promise<{ id: string; name: string; type: string; sizeBytes: number; createdAt: Date }>;
  /** document_downloads cascades, so the dashboard loses this doc's counts too. */
  delete(id: string): Promise<void>;
  recordDownload(documentId: string, userId: string): Promise<void>;
  topDownloaded(communityId: string, limit: number): Promise<Array<{ name: string; type: string; downloads: number }>>;
}

// ------------------------------------------------------------------ upload

export interface FileStorage {
  save(file: File): Promise<{ storageKey: string; sizeBytes: number }>;
  read(storageKey: string): Promise<ReadableStream | null>;
  urlFor(uploadId: string): string;
}

export interface UploadRepository {
  create(input: {
    uploaderId: string; filename: string; mime: string;
    sizeBytes: number; storageKey: string; kind: UploadKind;
  }): Promise<{ id: string; name: string; kind: UploadKind; url: string }>;
  findById(id: string): Promise<{
    id: string; storageKey: string; mime: string; filename: string;
    sizeBytes: number; kind: UploadKind;
  } | null>;
  /** Subset of `ids` that actually exist. Lets callers reject bad attachment
   *  references with a 422 instead of letting a FK violation surface as a 500. */
  existingIds(ids: string[]): Promise<string[]>;
}

// ---------------------------------------------------------------- commerce

export type Tier = {
  id: string; communityId: string; name: string;
  priceCents: number; billingPeriod: string; benefits: string[]; highlight: boolean;
};

export interface TierRepository {
  listForCommunity(communityId: string): Promise<Tier[]>;
  findById(id: string): Promise<Tier | null>;
  /** Inserts in the given order; array index becomes sortOrder. */
  createMany(
    communityId: string,
    tiers: Array<{ name: string; priceCents: number; billingPeriod: string; benefits: string[]; highlight: boolean }>,
  ): Promise<Tier[]>;
}

export interface SubscriptionRepository {
  create(input: {
    communityId: string; userId: string; tierId: string; status: SubscriptionStatus;
  }): Promise<{ id: string }>;
  markActive(subscriptionId: string): Promise<void>;
  /** Cancels any non-cancelled subscription a user holds in a community. */
  cancelForMember(communityId: string, userId: string): Promise<void>;
}

export interface PaymentRepository {
  create(input: {
    subscriptionId: string; amountCents: number; method: string;
    status: PaymentStatus; gatewayRef: string | null;
  }): Promise<{ id: string }>;
  markStatus(paymentId: string, status: PaymentStatus): Promise<void>;
  findByGatewayRef(ref: string): Promise<{ id: string; subscriptionId: string } | null>;
}

/**
 * The seam a real gateway plugs into. MockPaymentGateway confirms instantly —
 * which is exactly what the mockup depicts. Midtrans/Xendit implement this same
 * interface and the checkout service does not change.
 */
export interface PaymentGateway {
  charge(input: { amountCents: number; method: string; reference: string }): Promise<{
    gatewayRef: string;
    status: PaymentStatus;
    /** Real gateways return a redirect/QR payload here; the mock returns null. */
    redirectUrl: string | null;
  }>;
}

// -------------------------------------------------------------------- chat

export interface ConversationRepository {
  listForUser(userId: string): Promise<Array<{
    id: string; peerName: string; peerInitials: string; peerColor: string;
    lastMessage: string; lastMessageAt: Date | null; unread: number;
  }>>;
  findOrCreateDirect(userA: string, userB: string): Promise<{ id: string }>;
  isParticipant(conversationId: string, userId: string): Promise<boolean>;
  markRead(conversationId: string, userId: string): Promise<void>;
}

export interface MessageRepository {
  listForConversation(conversationId: string): Promise<Array<{
    id: string; senderId: string; body: string; createdAt: Date;
    attachments: Array<{ id: string; name: string; kind: UploadKind; url: string }>;
  }>>;
  create(input: { conversationId: string; senderId: string; body: string; attachmentIds?: string[] }): Promise<{ id: string; createdAt: Date }>;
}

// -------------------------------------------------------------------- live

export type LiveRoom = {
  id: string; communityId: string; streamKey: string; status: string; publishSecret: string | null;
};

export interface LiveRepository {
  findActiveForCommunity(communityId: string): Promise<{
    id: string; communityId: string; title: string; status: string; viewerCount: number;
    startedAt: Date | null; streamKey: string;
  } | null>;
  listChat(sessionId: string): Promise<Array<{ id: string; userName: string; body: string; createdAt: Date }>>;
  postChat(input: { sessionId: string; userId: string; body: string }): Promise<{ id: string; createdAt: Date }>;
  findByStreamKey(streamKey: string): Promise<
    { id: string; communityId: string; publishSecret: string | null } | null
  >;
  /**
   * The community's live room — the most recent session row, whatever its status.
   * `findActiveForCommunity` answers "is something on air right now?"; this one
   * answers "which room is this, and what key does it hold?", which an admin
   * needs precisely when nothing is broadcasting yet.
   */
  findLatestForCommunity(communityId: string): Promise<LiveRoom | null>;
  createForCommunity(input: {
    communityId: string; streamKey: string; publishSecret: string;
  }): Promise<LiveRoom>;
  /** Rotation is the only revocation there is — see LiveService.rotateStreamKey. */
  rotateStreamKey(sessionId: string, streamKey: string, publishSecret: string): Promise<void>;

  /** A member's permission to watch one session. See LiveService.watchToken. */
  createWatchToken(input: {
    token: string; sessionId: string; userId: string; expiresAt: Date;
  }): Promise<void>;
  /**
   * Resolved WITH its session's current stream key, so a rotated room invalidates
   * every token issued against the old key in the same lookup.
   */
  findWatchToken(token: string): Promise<
    { sessionId: string; userId: string; expiresAt: Date; streamKey: string } | null
  >;
  deleteExpiredWatchTokens(now: Date): Promise<void>;
  /** Rotation revokes viewers too, not just the publisher — see rotateStreamKey. */
  deleteWatchTokensForSession(sessionId: string): Promise<void>;

  /**
   * Marks a viewer present now. The viewer COUNT is derived from these rows —
   * `live_sessions` no longer carries a number, because nothing ever moved it.
   */
  touchViewer(sessionId: string, userId: string): Promise<void>;
  /**
   * Flips a provisioned session live. Returns false when no session holds that
   * key — the lifecycle hook then no-ops rather than inventing a session, since
   * a key can only exist because we issued it.
   */
  startByStreamKey(streamKey: string): Promise<boolean>;
  endByStreamKey(streamKey: string): Promise<boolean>;
}

// --------------------------------------------------------------- analytics

export type CreatorStats = {
  salesSummary: {
    totalRevenue: number; totalMembers: number; newMembersThisMonth: number;
    churnRate: number; successRate: number;
  };
  revenueByMonth: Array<{ month: string; value: number }>;
  tierDistribution: Array<{ name: string; pct: number; color: string }>;
  activityLog: Array<{ name: string; action: string; time: Date; type: string }>;
  recentMembers: Array<{ name: string; status: MemberStatus; joined: Date | null }>;
  topDocuments: Array<{ name: string; type: string; downloads: number }>;
};

export interface StatsRepository {
  forCommunity(communityId: string): Promise<CreatorStats>;
}

// ------------------------------------------------------------- ai co-builder

/**
 * What the AI has gathered so far. Every field is optional because the model
 * fills them in over several turns; the create endpoint is what insists on a
 * complete, valid draft (a draft coming back from the browser is user input,
 * not something the model vouched for).
 */
export type CommunityDraft = {
  name?: string;
  niche?: string;
  category?: string;
  description?: string;
  priceCents?: number;
  billingPeriod?: string;
  tiers?: Array<{ name: string; priceCents: number; billingPeriod?: string; benefits?: string[]; highlight?: boolean }>;
};

export type BuilderMessage = { role: "user" | "assistant"; content: string };

export type BuilderTurn = {
  /** What to show in the chat bubble. */
  reply: string;
  /** True once the model believes the draft is complete enough to create. */
  done: boolean;
  draft: CommunityDraft;
};

export interface CommunityBuilderAi {
  next(messages: BuilderMessage[]): Promise<BuilderTurn>;
}
