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
 */

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
