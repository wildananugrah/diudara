import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const creators = pgTable(
  "creator",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    whatsappNumber: varchar("whatsapp_number", { length: 32 }),
    email: varchar("email", { length: 255 }),
    passwordHash: varchar("password_hash", { length: 255 }),
    xenditAccountId: varchar("xendit_account_id", { length: 255 }),
    tierPlan: varchar("tier_plan", { length: 32 }).notNull().default("starter"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // email is the creator login identity (spec 9: email + password), so it must
    // resolve to exactly one account — otherwise findByEmail returns an
    // arbitrary row and which account you log into is non-deterministic.
    // Partial, because the spec allows WhatsApp-only creators with no email;
    // several creators may have NULL email, but no two may share an address.
    uniqueIndex("creator_email_unique")
      .on(table.email)
      .where(sql`${table.email} is not null`),
  ],
);

export const communities = pgTable(
  "community",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 120 }).notNull().unique(),
    niche: varchar("niche", { length: 128 }),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("community_creator_id_idx").on(table.creatorId)],
);

export const membershipTiers = pgTable(
  "membership_tier",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    name: varchar("name", { length: 128 }).notNull(),
    priceAmount: integer("price_amount").notNull(),
    billingCycle: varchar("billing_cycle", { length: 16 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [index("membership_tier_community_id_idx").on(table.communityId)],
);

export const channels = pgTable(
  "channel",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    platform: varchar("platform", { length: 16 }).notNull(),
    externalGroupId: varchar("external_group_id", { length: 255 }),
    inviteLink: varchar("invite_link", { length: 512 }),
    botStatus: varchar("bot_status", { length: 32 }).notNull().default("disconnected"),
  },
  (table) => [
    index("channel_community_id_idx").on(table.communityId),
    // Phase 4's gating resolves an inbound group id back to exactly one
    // community. Without this, two creators could both connect Telegram group
    // -1001234567890 and the lookup would find two owners — and one community
    // could connect the same group twice. Partial, because external_group_id is
    // null until the creator supplies one. Added while the table is empty:
    // retrofitting it after real rows exist needs a data-cleanup migration.
    uniqueIndex("channel_platform_group_unique")
      .on(table.platform, table.externalGroupId)
      .where(sql`${table.externalGroupId} is not null`),
  ],
);

export const members = pgTable("member", {
  id: uuid("id").primaryKey().defaultRandom(),
  whatsappNumber: varchar("whatsapp_number", { length: 32 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable(
  "subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    tierId: uuid("tier_id")
      .notNull()
      .references(() => membershipTiers.id),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    nextBillingDate: date("next_billing_date"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    // startedAt is null until the first successful payment, so churn timing
    // (spec 8.3) needs an independent record of when the row came into being.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // No BEFORE UPDATE trigger backs this column — the migration constraint
    // forbids hand-written SQL and drizzle-kit does not generate triggers — so
    // it would otherwise freeze at creation time. Every repository method that
    // updates a subscription row (added starting Task 6/7, which write these
    // rows for the first time) MUST set `updatedAt: new Date()` explicitly.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("subscription_member_id_idx").on(table.memberId),
    index("subscription_tier_id_idx").on(table.tierId),
    // A double-submit at checkout creates two PENDING subscriptions for one
    // (member, tier) and nothing decided which was authoritative. Phase 4 is the
    // first phase to act on one — activation enqueues a `grant_access` row — so
    // two activations mean two single-use invite links for the same member, one of
    // which can be handed to somebody who never paid.
    //
    // A member can only hold ONE active membership of a given tier: a renewal
    // updates the same subscription row (`markPaid` moves next_billing_date), it
    // does not create another. This index is what ARBITRATES that, rather than the
    // `not exists` predicate in markPaid — under READ COMMITTED two concurrent
    // activations cannot see each other's uncommitted row, so the predicate alone
    // is a TOCTOU. The predicate handles the ordinary already-committed case
    // gracefully; a true race violates this index, the transaction rolls back with
    // the webhook event id unspent, and the provider's retry then takes the
    // graceful path.
    //
    // PARTIAL, on `active` only: `pending`, `cancelled` and `expired` duplicates
    // are all legitimate history. Added while every subscription row in existence
    // is a test row — retrofitting it over real duplicates needs a cleanup
    // migration first.
    uniqueIndex("subscription_member_tier_active_unique")
      .on(table.memberId, table.tierId)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const transactions = pgTable(
  "transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    amount: integer("amount").notNull(),
    paymentMethod: varchar("payment_method", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    gatewayReferenceId: varchar("gateway_reference_id", { length: 255 }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // paidAt is NULL for pending/failed attempts, so revenue-over-time and
    // funnel analysis (spec 2 dashboard) cannot be built from it alone.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Same carry-forward as subscription.updatedAt above: no trigger backs
    // this column, so every repository method that updates a transaction row
    // MUST set `updatedAt: new Date()` explicitly. Task 7's webhook test
    // should assert updated_at moved past created_at after activation.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("transaction_subscription_id_idx").on(table.subscriptionId)],
);

export const activityLogs = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id").references(() => members.id),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    eventType: varchar("event_type", { length: 32 }).notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("activity_log_member_id_idx").on(table.memberId),
    index("activity_log_community_id_idx").on(table.communityId),
  ],
);

export const courses = pgTable(
  "course",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    title: varchar("title", { length: 255 }).notNull(),
    dripSchedule: jsonb("drip_schedule"),
  },
  (table) => [index("course_community_id_idx").on(table.communityId)],
);

export const enrollments = pgTable(
  "enrollment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id),
    progressPercent: integer("progress_percent").notNull().default(0),
    certificateStatus: varchar("certificate_status", { length: 32 }),
  },
  (table) => [
    index("enrollment_member_id_idx").on(table.memberId),
    index("enrollment_course_id_idx").on(table.courseId),
  ],
);

export const events = pgTable(
  "event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    title: varchar("title", { length: 255 }).notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    meetingLink: varchar("meeting_link", { length: 512 }),
    streamKey: varchar("stream_key", { length: 128 }),
    status: varchar("status", { length: 16 }).notNull().default("scheduled"),
    hlsPlaybackPath: varchar("hls_playback_path", { length: 512 }),
    recordingUrl: varchar("recording_url", { length: 512 }),
  },
  (table) => [
    index("event_community_id_idx").on(table.communityId),
    // Spec 7: stream_key is a secret, unique, rotated per session. Phase 8's
    // MediaMTX on-publish webhook resolves a key to exactly one event, and
    // ambiguity in a security-token lookup is a real hazard. Partial, because
    // the key is null until a session is scheduled.
    uniqueIndex("event_stream_key_unique")
      .on(table.streamKey)
      .where(sql`${table.streamKey} is not null`),
  ],
);

export const eventRsvps = pgTable(
  "event_rsvp",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    status: varchar("status", { length: 16 }).notNull().default("registered"),
  },
  (table) => [
    index("event_rsvp_member_id_idx").on(table.memberId),
    index("event_rsvp_event_id_idx").on(table.eventId),
  ],
);

export const webhookEvents = pgTable("webhook_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: varchar("provider", { length: 32 }).notNull(),
  // Unique: the existence of a row means "already handled". This is the
  // entire replay defence — Xendit's static token cannot provide one.
  providerEventId: varchar("provider_event_id", { length: 255 }).notNull().unique(),
  eventType: varchar("event_type", { length: 64 }).notNull(),
  payload: jsonb("payload"),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Transactional outbox. A payment activation writes a row here in the SAME
 * transaction as the subscription update, so the intent to invite is atomic
 * with the payment and can never be lost. The worker sends outside any
 * transaction — a Telegram outage must delay an invite, never roll back a
 * payment.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: varchar("last_error", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("outbox_claim_idx").on(table.status, table.nextAttemptAt)]
);

/**
 * Who currently has access to which channel.
 * UNIQUE (member_id, channel_id) is the grant-idempotency mechanism: a retried
 * outbox row must not issue a second invite link, and the database arbitrates
 * that, not a pre-check.
 */
export const channelMemberships = pgTable(
  "channel_membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    inviteLink: varchar("invite_link", { length: 512 }),
    /**
     * The member's id ON THE PLATFORM (a Telegram integer user id), once we learn
     * it.
     *
     * NULL at grant time, always, and that is not an oversight: access is granted
     * with an INVITE LINK precisely because we do not know who the member is on
     * Telegram — a WhatsApp number is all checkout gives us. The id only becomes
     * knowable when the member actually JOINS.
     *
     * Filled by `POST /webhooks/telegram` (Task 7b), which receives Telegram's
     * `chat_member` update and matches it to this row by the `invite_link` it
     * reports — single-use per member, so it identifies exactly one row (see
     * `channel_membership_invite_link_unique`).
     *
     * It exists because revocation NEEDS it: `banChatMember` addresses a user id.
     * A row that still has none cannot be revoked automatically, and
     * `RevokeChannelAccess` reports `no_provider_member_id_recorded` rather than
     * claiming success — which is what EVERY revocation did before that endpoint.
     *
     * DELIBERATELY SURVIVES A REVOKE. Neither `revoke` nor `claim`'s reactivation
     * clears it, only the link. `banChatMember` also blocks the user from joining
     * via any invite link, so a churned member who re-pays must be UNBANNED first,
     * and `unbanChatMember` needs this id — `GrantChannelAccess` reads it back off
     * a reactivated row and passes it as `previousExternalMemberId`.
     */
    externalMemberId: varchar("external_member_id", { length: 64 }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("channel_membership_member_channel_unique").on(table.memberId, table.channelId),
    index("channel_membership_channel_idx").on(table.channelId),
    // `POST /webhooks/telegram` resolves an inbound invite link back to exactly one
    // membership, so it can record the joining member's platform user id. That
    // lookup is how revocation becomes automatable at all, and ambiguity in it
    // would attach a Telegram user id to an arbitrary one of two rows — aiming a
    // later `banChatMember` at the wrong member of the wrong group.
    //
    // Same reasoning as `event_stream_key_unique`: a lookup keyed on a CREDENTIAL
    // must resolve to one row. Links are single-use per member and the column is
    // nulled on revoke and on reactivation, so this holds by construction — the
    // index is what makes it hold by GUARANTEE. Partial, because the column is null
    // until a grant completes and null again after a revoke.
    uniqueIndex("channel_membership_invite_link_unique")
      .on(table.inviteLink)
      .where(sql`${table.inviteLink} is not null`),
  ]
);
