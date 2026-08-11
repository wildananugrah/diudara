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

/** `GET /ai/status` — apps/api/src/routes/ai.ts. */
export interface AiStatus {
  enabled: boolean;
}

/** `GET /streaming/status` — apps/api/src/routes/streaming.ts. Mirrors `AiStatus` exactly. */
export interface StreamingStatus {
  enabled: boolean;
}

/**
 * `EventRecord`, as `GET /communities/:communityId/events` returns each row —
 * apps/api/src/application/ports/event-repository.port.ts.
 *
 * `streamKey` IS A SECRET, exactly like `Tier.priceAmount` is money: the API
 * returns it only to the creator who owns the community (a stranger's
 * request 404s before any row is read — see events.ts's own tests), and
 * EventsPage.tsx must never cache one across a community switch or put one
 * in a URL. It appears here (not just on the create response) so a creator
 * who lost their OBS settings can recover it.
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
}

/**
 * `ScheduledSession` — apps/api/src/application/use-cases/schedule-live-session.ts
 * — `POST /communities/:communityId/events`'s response. `rtmpUrl` appears
 * ONLY here: it is never persisted, so it never appears in `LiveSession`
 * (the list response) again after this call returns.
 */
export interface CreatedLiveSession {
  id: string;
  title: string;
  status: string;
  rtmpUrl: string;
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
