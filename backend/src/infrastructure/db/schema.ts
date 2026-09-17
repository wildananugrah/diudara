import {
  pgTable, text, integer, boolean, timestamp, jsonb, primaryKey, index, uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  handle: text("handle").notNull().unique(),
  avatarColor: text("avatar_color").notNull().default("#93A8C2"),
  initials: text("initials").notNull(),
  createdAt: now(),
});

export const communities = pgTable("communities", {
  // Slug, not UUID: the frontend routes on /community/bimbel-sbmptn and the seed
  // must reproduce the mockup's URLs exactly.
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  niche: text("niche").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull().default(""),
  color: text("color").notNull().default("var(--langit)"),
  priceCents: integer("price_cents").notNull().default(0),
  billingPeriod: text("billing_period").notNull().default(""),
  ownerId: text("owner_id").notNull().references(() => users.id),
  createdAt: now(),
});

export const tiers = pgTable("tiers", {
  id: id(),
  communityId: text("community_id").notNull().references(() => communities.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  billingPeriod: text("billing_period").notNull().default("/ bulan"),
  benefits: jsonb("benefits").$type<string[]>().notNull().default([]),
  highlight: boolean("highlight").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const communityMembers = pgTable("community_members", {
  communityId: text("community_id").notNull().references(() => communities.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").$type<"owner" | "admin" | "member">().notNull().default("member"),
  status: text("status").$type<"active" | "pending" | "churned">().notNull().default("active"),
  tierId: text("tier_id").references(() => tiers.id),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.communityId, t.userId] }),
  byUser: index("community_members_user_idx").on(t.userId),
}));

export const uploads = pgTable("uploads", {
  id: id(),
  uploaderId: text("uploader_id").notNull().references(() => users.id),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storageKey: text("storage_key").notNull(),
  kind: text("kind").$type<"image" | "video" | "audio" | "file">().notNull(),
  createdAt: now(),
});

export const posts = pgTable("posts", {
  id: id(),
  communityId: text("community_id").notNull().references(() => communities.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull().references(() => users.id),
  // One table, five types. The mock already derives feedPosts from forumPosts +
  // announcements + calendarSchedule, so modelling them separately would let the
  // feed drift from the tabs that are supposed to be the same content.
  type: text("type").$type<"diskusi" | "pengumuman" | "konten" | "event" | "anggota">().notNull(),
  tag: text("tag").notNull().default(""),
  topic: text("topic"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  syllabus: text("syllabus"),
  eventDate: text("event_date"),
  eventTime: text("event_time"),
  eventLocation: text("event_location"),
  /**
   * External meeting URL for an event (Zoom/Meet/Teams). Separate from
   * eventLocation, which is descriptive text like "Online via Zoom" — this is
   * the thing members actually click.
   */
  meetingUrl: text("meeting_url"),
  hasLiveRoom: boolean("has_live_room").notNull().default(false),
  inviteTarget: text("invite_target"),
  createdAt: now(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byCommunity: index("posts_community_idx").on(t.communityId, t.createdAt),
  byType: index("posts_type_idx").on(t.communityId, t.type),
}));

export const postAttachments = pgTable("post_attachments", {
  postId: text("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
  uploadId: text("upload_id").notNull().references(() => uploads.id, { onDelete: "cascade" }),
}, (t) => ({ pk: primaryKey({ columns: [t.postId, t.uploadId] }) }));

export const comments = pgTable("comments", {
  id: id(),
  postId: text("post_id").notNull().references(() => posts.id, { onDelete: "cascade" }),
  authorId: text("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: now(),
}, (t) => ({ byPost: index("comments_post_idx").on(t.postId, t.createdAt) }));

export const commentLikes = pgTable("comment_likes", {
  commentId: text("comment_id").notNull().references(() => comments.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
}, (t) => ({ pk: primaryKey({ columns: [t.commentId, t.userId] }) }));

export const syllabi = pgTable("syllabi", {
  id: text("id").primaryKey(),
  communityId: text("community_id").notNull().references(() => communities.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const syllabusItems = pgTable("syllabus_items", {
  id: id(),
  syllabusId: text("syllabus_id").notNull().references(() => syllabi.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  type: text("type").notNull(),
  duration: text("duration").notNull().default(""),
  // The lesson itself. Nullable: an item can be outlined before its file is
  // ready, and a quiz item carries questions instead of a file.
  // ON DELETE SET NULL, not CASCADE — losing a file must not delete the lesson.
  uploadId: text("upload_id").references(() => uploads.id, { onDelete: "set null" }),
  /**
   * A YouTube link, as the creator pasted it, for lessons hosted off-platform.
   * Mutually exclusive with uploadId — an item has one source, not two.
   */
  sourceUrl: text("source_url"),
  sortOrder: integer("sort_order").notNull().default(0),
});

/**
 * Quiz questions belong to a `syllabus_items` row of type "quiz".
 *
 * A true/false question is a two-option multiple choice, so both formats share
 * one options table and one read path; `format` exists only so the editor knows
 * whether to render free-text options or a fixed Benar/Salah pair.
 */
export const quizQuestions = pgTable("quiz_questions", {
  id: id(),
  itemId: text("item_id").notNull().references(() => syllabusItems.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  format: text("format").$type<"multiple_choice" | "true_false">().notNull().default("multiple_choice"),
  /** Shown after the answer is revealed. Optional. */
  explanation: text("explanation"),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => ({ byItem: index("quiz_questions_item_idx").on(t.itemId, t.sortOrder) }));

export const quizOptions = pgTable("quiz_options", {
  id: id(),
  questionId: text("question_id").notNull().references(() => quizQuestions.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  isCorrect: boolean("is_correct").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const documents = pgTable("documents", {
  id: id(),
  communityId: text("community_id").notNull().references(() => communities.id, { onDelete: "cascade" }),
  uploadId: text("upload_id").references(() => uploads.id),
  name: text("name").notNull(),
  type: text("type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdAt: now(),
});

// Exists so CreatorDashboard's topDocuments.downloads has a real source. Without
// this table that number can only ever be fabricated (see SPEC.md §6.3).
export const documentDownloads = pgTable("document_downloads", {
  id: id(),
  documentId: text("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: now(),
}, (t) => ({ byDoc: index("document_downloads_doc_idx").on(t.documentId) }));

export const subscriptions = pgTable("subscriptions", {
  id: id(),
  communityId: text("community_id").notNull().references(() => communities.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tierId: text("tier_id").notNull().references(() => tiers.id),
  status: text("status").$type<"pending" | "active" | "cancelled" | "expired">().notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdAt: now(),
});

export const payments = pgTable("payments", {
  id: id(),
  subscriptionId: text("subscription_id").notNull().references(() => subscriptions.id, { onDelete: "cascade" }),
  amountCents: integer("amount_cents").notNull(),
  method: text("method").notNull(),
  // Failed rows are kept deliberately: successRate on the dashboard is
  // paid / (paid + failed), so discarding failures makes it unanswerable.
  status: text("status").$type<"pending" | "paid" | "failed">().notNull().default("pending"),
  gatewayRef: text("gateway_ref"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({ byRef: index("payments_gateway_ref_idx").on(t.gatewayRef) }));

export const conversations = pgTable("conversations", {
  id: id(),
  createdAt: now(),
});

export const conversationParticipants = pgTable("conversation_participants", {
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
}, (t) => ({
  pk: primaryKey({ columns: [t.conversationId, t.userId] }),
  byUser: index("conversation_participants_user_idx").on(t.userId),
}));

export const messages = pgTable("messages", {
  id: id(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull().references(() => users.id),
  body: text("body").notNull().default(""),
  createdAt: now(),
}, (t) => ({ byConversation: index("messages_conversation_idx").on(t.conversationId, t.createdAt) }));

export const messageAttachments = pgTable("message_attachments", {
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  uploadId: text("upload_id").notNull().references(() => uploads.id, { onDelete: "cascade" }),
}, (t) => ({ pk: primaryKey({ columns: [t.messageId, t.uploadId] }) }));

export const liveSessions = pgTable("live_sessions", {
  id: id(),
  communityId: text("community_id").notNull().references(() => communities.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Live"),
  status: text("status").$type<"idle" | "live" | "ended">().notNull().default("idle"),
  streamKey: text("stream_key").notNull(),
  /**
   * The broadcast credential. Separate from `streamKey` because Stage 4 puts the
   * key in every viewer's HLS URL — visible in devtools — so the key alone can no
   * longer be what authorises a publish. Nullable: a room provisioned before this
   * existed has none, and no secret means no publishing until an admin opens the
   * panel, which mints one. Never returned to a non-admin.
   */
  publishSecret: text("publish_secret"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: now(),
}, (t) => ({ byKey: uniqueIndex("live_sessions_stream_key_idx").on(t.streamKey) }));

/**
 * A member's permission to WATCH one session, handed to MediaMTX as `?token=` on
 * the HLS URL and validated by the read branch of /webhooks/mediamtx/auth.
 *
 * Rows are disposable: they are pruned when they expire, and cascade away with
 * the session or the user.
 */
export const liveWatchTokens = pgTable("live_watch_tokens", {
  token: text("token").primaryKey(),
  sessionId: text("session_id").notNull().references(() => liveSessions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: now(),
}, (t) => ({ bySession: index("live_watch_tokens_session_idx").on(t.sessionId) }));

/**
 * Who is watching RIGHT NOW. One row per viewer per session, refreshed by the
 * player while it plays; a viewer is "present" while `last_seen_at` is recent.
 *
 * This exists because the viewer count used to be a stored integer nobody
 * incremented — 128, seeded, forever (SPEC.md §6.3). A number on a screen either
 * comes from somewhere or should not be there.
 */
export const liveViewers = pgTable("live_viewers", {
  sessionId: text("session_id").notNull().references(() => liveSessions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.sessionId, t.userId] }),
  bySeen: index("live_viewers_seen_idx").on(t.sessionId, t.lastSeenAt),
}));

export const liveChatMessages = pgTable("live_chat_messages", {
  id: id(),
  sessionId: text("session_id").notNull().references(() => liveSessions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: now(),
}, (t) => ({ bySession: index("live_chat_session_idx").on(t.sessionId, t.createdAt) }));

/**
 * One row per thing a member should be told about, addressed to that member.
 *
 * Personal only (design spec 2026-09-17): a community announcement does NOT land
 * here, because one announcement would mean one row per member. Everything in
 * this table concerns the reader directly.
 */
export const notifications = pgTable("notifications", {
  id: id(),
  /** The RECIPIENT, not the person who caused it. */
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  /** Who caused it. Null for events nobody triggered, and when that account is gone. */
  actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
  communityId: text("community_id").references(() => communities.id, { onDelete: "cascade" }),
  /** The thing this is about — a post, a conversation, a payment. Untyped on purpose. */
  entityId: text("entity_id"),
  /**
   * What the sentence needs, captured when the row is written: names, titles,
   * amounts. NOT joined at read time — a notification should still read
   * correctly after the post it mentions is renamed.
   */
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: now(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => ({
  byUser: index("notifications_user_idx").on(t.userId, t.createdAt),
  // Partial index: the badge polls a COUNT of exactly these rows every 30s.
  unread: index("notifications_unread_idx").on(t.userId).where(sql`read_at IS NULL`),
}));

export const trendingTags = pgTable("trending_tags", {
  tag: text("tag").primaryKey(),
  sortOrder: integer("sort_order").notNull().default(0),
});
