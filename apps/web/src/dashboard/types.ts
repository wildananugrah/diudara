/**
 * The dashboard API's response shapes.
 *
 * Declared here rather than imported because the API does not export them: only
 * the REQUEST schemas live in `@diudara/shared` (`createTierSchema`,
 * `connectChannelSchema`, …), and those are imported directly where they are
 * needed. `apps/web/src/api.ts` already carries the public checkout page's
 * response types for the same reason and says the same thing: if response types
 * are ever added to the shared package, replace these with imports rather than
 * keeping two copies in step by hand.
 *
 * Each type names the file on the API side it mirrors, so a change there has a
 * findable counterpart here.
 *
 * `CommunityDraft` (below) is the ONE exception: `@diudara/shared` exports it as
 * a real TYPE (not just a request schema), because Phase 7's AI provider port
 * and this dashboard both need the identical shape. Imported type-only —
 * `import type` — so the `communityDraftSchema` Zod object it is inferred from
 * is never pulled into the browser bundle; see ChannelsPage.tsx's docstring on
 * `TELEGRAM_NUMERIC_CHAT_ID` for why every `@diudara/shared` import here is
 * type-only.
 */
import type { CommunityDraft } from "@diudara/shared";

/** `CommunityRecord` — apps/api/src/application/ports/community-repository.port.ts. */
export interface Community {
  id: string;
  creatorId: string;
  name: string;
  slug: string;
  niche: string | null;
  /** `active` | `paused` | `archived`. A free varchar in the schema, so treated as a string. */
  status: string;
  /**
   * `paid` | `request`. `request` means this community has no priced checkout —
   * a member asks to join and the owner approves or rejects (see
   * `MembersPage.tsx`'s join-request queue). A free varchar, same reasoning as
   * `status`.
   */
  accessMode: string;
  /** ISO 8601 — `Date` serialised by Hono's `c.json`. */
  createdAt: string;
}

/** `TierRecord` — apps/api/src/application/ports/membership-tier-repository.port.ts. */
export interface Tier {
  id: string;
  communityId: string;
  name: string;
  /** Integer Rupiah. Never a float — see `formatRupiah`. */
  priceAmount: number;
  billingCycle: string;
  isActive: boolean;
}

/** `ChannelRecord` — apps/api/src/application/ports/channel-repository.port.ts. */
export interface Channel {
  id: string;
  communityId: string;
  platform: string;
  externalGroupId: string | null;
  inviteLink: string | null;
  botStatus: string;
}

/** `CommunityMetrics` — apps/api/src/application/ports/analytics-repository.port.ts. */
export interface CommunityMetrics {
  members: { active: number; pastDue: number; churned: number };
  /**
   * Integer Rupiah, successful transactions only, and GROSS — DIUDARA's platform
   * fee is deducted by Xendit's split rule before the creator receives anything.
   * The UI must never label this as what the creator earned.
   */
  grossRevenueAmount: number;
  tierDistribution: Array<{
    tierId: string;
    tierName: string;
    priceAmount: number;
    activeMembers: number;
  }>;
}

/** `ActivityFeedEntry` — apps/api/src/application/use-cases/get-community-activity.ts. */
export interface ActivityEntry {
  id: string;
  eventType: string;
  /** Already Indonesian: decided by `describeActivityEvent` in the API's domain layer. */
  label: string;
  /** `warning` means automation could not finish and a person has to act. */
  severity: "info" | "warning";
  memberId: string | null;
  memberName: string | null;
  createdAt: string;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  /** `null` on the last page — never a cursor that would fetch nothing. */
  nextCursor: string | null;
}

/** `MemberRosterEntry` — apps/api/src/application/use-cases/list-community-members.ts. */
export interface MemberRow {
  memberId: string;
  subscriptionId: string;
  name: string | null;
  /** Members' personal data (UU PDP 27/2022). Shown on this one screen and the CSV. */
  whatsappNumber: string;
  tierName: string;
  /** `active` | `past_due` | `churned`. */
  status: string;
  joinedAt: string;
  /** A calendar date `YYYY-MM-DD`, or null when there is no next period. */
  nextBillingDate: string | null;
}

export interface MemberRosterPage {
  members: MemberRow[];
  nextCursor: string | null;
}

/**
 * `PendingJoinRequestRow` — apps/api/src/application/ports/join-request-repository.port.ts.
 * `GET /communities/:communityId/join-requests`'s response, one row per pending
 * request for this community. Never includes decided rows — see
 * `ListJoinRequests` (apps/api).
 */
export interface JoinRequestRow {
  id: string;
  memberId: string;
  /**
   * `members.name`, verbatim — including `null`. THE REPOSITORY DELIBERATELY
   * DOES NOT COALESCE THIS TO `''`: a WhatsApp-only signup may have no name at
   * all, and a caller that turned the gap into an empty string once produced
   * "Permintaan bergabung baru di Kelas Rina:  ingin bergabung ke tier Free." —
   * a broken sentence with a doubled space. `MembersPage.tsx` is the caller
   * that knows this is a dashboard table cell, and renders "Tanpa nama" itself
   * rather than trusting a coalesced value from here.
   */
  memberName: string | null;
  memberWhatsappNumber: string;
  tierId: string;
  tierName: string;
  /** ISO 8601 — `Date` serialised by Hono's `c.json`. */
  createdAt: string;
}

/**
 * `POST /communities/:communityId/join-requests/:requestId/approve` or
 * `.../reject` — apps/api/src/application/use-cases/decide-join-request.ts.
 * `subscriptionId` is non-null only for an approval; a rejection never creates
 * one.
 */
export interface JoinRequestDecisionResult {
  subscriptionId: string | null;
}

/** `GET /ai/status` — apps/api/src/routes/ai.ts. */
export interface AiStatus {
  enabled: boolean;
}

/** `GET /streaming/status` — apps/api/src/routes/streaming.ts. Mirrors `AiStatus` exactly. */
export interface StreamingStatus {
  enabled: boolean;
}

/**
 * `ListedLiveSession`, as `GET /communities/:communityId/events` returns each
 * row — apps/api/src/application/use-cases/schedule-live-session.ts (Task 2
 * added `rtmpUrl`/`whipUrl` here; it started as `EventRecord` alone).
 *
 * `streamKey` IS A SECRET, exactly like `Tier.priceAmount` is money: the API
 * returns it only to the creator who owns the community (a stranger's
 * request 404s before any row is read — see events.ts's own tests), and
 * EventsPage.tsx must never cache one across a community switch or put one
 * in a URL. It appears here (not just on the create response) so a creator
 * who lost their OBS settings can recover it.
 *
 * `rtmpUrl`/`whipUrl` are REBUILT per row from the persisted `streamKey`
 * (Task 2 review, Important #3), not persisted themselves — so a session
 * scheduled yesterday still carries a live publish target today, which is
 * exactly what Task 3's "go live from the browser" button needs: without
 * this, browser publishing would only ever work for a session created in
 * the current page-load. Both are `null` together, never independently —
 * either streaming is disabled on this server, or (pathologically) the row
 * has no `streamKey` at all — so `whipUrl === null` is Task 3's UI's single
 * signal to hide the browser-publish path for a session.
 */
export interface LiveSession {
  id: string;
  communityId: string;
  title: string;
  /** ISO 8601, or null — a session created with no explicit time. */
  scheduledAt: string | null;
  streamKey: string | null;
  /** `scheduled` | `live` | `ended`. */
  status: string;
  hlsPlaybackPath: string | null;
  recordingUrl: string | null;
  rtmpUrl: string | null;
  whipUrl: string | null;
}

/**
 * `ScheduledSession` — apps/api/src/application/use-cases/schedule-live-session.ts
 * — `POST /communities/:communityId/events`'s response. `rtmpUrl`/`whipUrl`
 * are never `null` here (unlike `LiveSession`'s): this endpoint 503s before
 * returning anything at all when streaming is not configured (see
 * `routes/events.ts`), so reaching a 201 already proves both URLs exist.
 */
export interface CreatedLiveSession {
  id: string;
  title: string;
  status: string;
  rtmpUrl: string;
  whipUrl: string;
  streamKey: string;
  hlsPlaybackPath: string;
}

/**
 * `POST /ai/messages` — apps/api/src/routes/ai.ts, backed by
 * `SendAiMessage.execute` (apps/api/src/application/use-cases/send-ai-message.ts).
 * `draft` is `null` on every turn that is not a completed proposal (a
 * clarifying question, small talk, a refusal) — never an error signal.
 */
export interface AiMessageResult {
  conversationId: string;
  reply: string;
  draft: CommunityDraft | null;
}

/** `RevokeChannelAccessResult` — apps/api/src/application/use-cases/revoke-channel-access.ts. */
export interface RevokeResult {
  revoked: number;
  /**
   * TRUE ONLY WHEN EVERY channel was actually handled at the provider. False means
   * the creator has to remove the member from at least one group BY HAND, and the
   * UI must not report success — see `MembersPage`.
   */
  automated: boolean;
  channels: Array<{
    channelId: string;
    platform: string;
    automated: boolean;
    reason?: string;
  }>;
}
