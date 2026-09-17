export type MemberRole = "owner" | "admin" | "member";
export type MemberStatus = "active" | "pending" | "churned";
export type PostType = "diskusi" | "pengumuman" | "konten" | "event" | "anggota";
export type UploadKind = "image" | "video" | "audio" | "file";
export type PaymentStatus = "pending" | "paid" | "failed";
export type SubscriptionStatus = "pending" | "active" | "cancelled" | "expired";
export type LiveStatus = "idle" | "live" | "ended";
/** Drives the icon and the player chrome the Materi tab renders per item. */
export type SyllabusItemType = "video" | "ebook" | "audio" | "quiz";
/** A true/false question is a 2-option multiple choice; this only steers the editor UI. */
export type QuizFormat = "multiple_choice" | "true_false";

export type User = {
  id: string;
  email: string;
  name: string;
  handle: string;
  avatarColor: string;
  initials: string;
};

export type Community = {
  id: string;
  name: string;
  niche: string;
  category: string;
  description: string;
  color: string;
  priceCents: number;
  billingPeriod: string;
  ownerId: string;
};

export type Post = {
  id: string;
  communityId: string;
  authorId: string;
  type: PostType;
  tag: string;
  topic: string | null;
  title: string;
  body: string;
  syllabus: string | null;
  eventDate: string | null;
  eventTime: string | null;
  eventLocation: string | null;
  meetingUrl: string | null;
  hasLiveRoom: boolean;
  inviteTarget: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Who the caller is within a community. `null` role means not a member. */
export type Membership = {
  communityId: string;
  userId: string;
  role: MemberRole;
  status: MemberStatus;
  tierId: string | null;
  joinedAt: Date;
};

export const isCommunityAdmin = (m: Membership | null): boolean =>
  m !== null && m.status === "active" && (m.role === "owner" || m.role === "admin");

/** Post types only an owner/admin may author. Mirrors PostEditorModal's availableTypes gate. */
export const ADMIN_ONLY_POST_TYPES: readonly PostType[] = ["pengumuman", "konten", "event"];

export const SYLLABUS_ITEM_TYPES: readonly SyllabusItemType[] = ["video", "ebook", "audio", "quiz"];

/**
 * Item types that may point at an external link instead of an uploaded file.
 * A quiz carries questions, not media, so it is never linkable.
 *
 * What counts as a valid link differs by type — see requireSource in
 * CommunityService: video takes YouTube only, audio takes YouTube or a direct
 * audio URL, and an e-book takes any document URL.
 */
export const LINKABLE_ITEM_TYPES: readonly SyllabusItemType[] = ["video", "audio", "ebook"];
export const QUIZ_FORMATS: readonly QuizFormat[] = ["multiple_choice", "true_false"];
