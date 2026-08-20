import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  text,
  index,
  uniqueIndex,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * The pivot's third, independent identity table — a user who follows, posts,
 * goes live and offers memberships. `creator` and `member` are unchanged and
 * keep both existing login paths working; nothing here migrates them. Named
 * `app_user`, not `user`: `user` is a reserved SQL keyword that would need
 * quoting in every hand-written query, and this project debugs through
 * `psql` constantly.
 */
export const appUsers = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    handle: varchar("handle", { length: 30 }).notNull().unique(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    // Nullable: offered at signup, not required. A user without one has
    // exactly one reset channel — see the spec's §5.
    whatsappNumber: varchar("whatsapp_number", { length: 32 }),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    bio: varchar("bio", { length: 300 }),
    // Bumped by a completed password reset. The token carries the value it
    // was issued under and `requireUserAuth` compares — which is what makes
    // "a reset ends all sessions" possible at all, since a JWT is stateless
    // and cannot otherwise be revoked short of rotating JWT_SECRET.
    sessionEpoch: integer("session_epoch").notNull().default(0),
    // Where THIS user's membership money settles (Phase 5a). Nullable, and it
    // holds THREE states, not two — NULL, the `XENDIT_ACCOUNT_PROVISIONING`
    // sentinel, and a real account id. `domain/payment-account.ts` owns all
    // three and the predicates that tell them apart; read that file before
    // touching this column, and never truthiness-check it: the sentinel is
    // truthy, and a truthy read is what would send `for_account_id:
    // "provisioning:in-progress"` to the provider.
    //
    // The same shape as `creator.xendit_account_id` below, deliberately
    // separate from it: `creator` is the untouchable /dashboard/* identity, and
    // an app_user is a different owner entirely.
    xenditAccountId: varchar("xendit_account_id", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Task 5's password reset. One row per issued link.
 *
 * `tokenHash` is a sha256 hex digest of the token that was sent, NEVER the
 * token itself — a database read (a backup, a replica, an operator's SELECT)
 * must not yield a working reset link. See `domain/reset-token.ts`.
 *
 * `requestIpHash` is hashed too, for the same reason, but — review finding
 * F4 — it is NO LONGER used to enforce a limit. `X-Forwarded-For`'s leftmost
 * entry is client-supplied, and this repository has no committed nginx
 * configuration for the general API surface that proves anything ever
 * overwrites it (`infra/nginx/live-hls.conf.template` is a fragment scoped
 * to `/live/`, `/whip/` and `/webhooks/mediamtx/` only). A limit keyed on a
 * value the caller controls is not a limit, and it was ALSO itself an
 * oracle (F6): since `userId` is `NOT NULL`, only a REAL account's request
 * can ever produce a row, so a shared per-IP counter let an attacker read
 * whether some OTHER email exists by watching their own IP's count climb
 * only on hits. The column stays for forensic/audit value only — see
 * `RequestPasswordReset`'s own docstring.
 *
 * The two indexes below back the counts `RequestPasswordReset` reads: the
 * per-account one is load-bearing (the rate limit itself); the per-IP one
 * now backs only ad-hoc audit queries, not a runtime enforcement path.
 * Without them either count seq-scans this table, the same defect a
 * previous phase found in the renewal passes.
 */
export const passwordResetTokens = pgTable(
  "password_reset_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    requestIpHash: varchar("request_ip_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("password_reset_user_created_idx").on(table.userId, table.createdAt),
    index("password_reset_ip_created_idx").on(table.requestIpHash, table.createdAt),
  ]
);

/**
 * Task 5 review finding F3's fix. One row per existing-email signup notice
 * actually sent (`RegisterUser.notifyExistingOwner`) — the rate-limit ledger
 * for that sender, since it had none: measured, 25 signup attempts against
 * one address delivered 25 messages, all 201, an unrate-limited amplifier
 * (paid Fonnte sends, or an inbox flood) triggerable by anyone who knows a
 * victim's email.
 *
 * A SEPARATE TABLE from `password_reset_token`, deliberately, rather than a
 * shared budget: sharing one counter between "someone tried to sign up as
 * you" and "you asked to reset your own password" would let an attacker who
 * exhausts THIS cap by spamming signups also block the real owner's own
 * password-reset requests — a self-inflicted denial of service this table's
 * separation avoids entirely.
 */
export const signupNotices = pgTable(
  "signup_notice",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("signup_notice_user_created_idx").on(table.userId, table.createdAt)]
);

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
    /**
     * `paid` | `request`. Default `paid` means existing rows keep today's
     * behaviour with no backfill: a member can only join by paying through
     * Xendit unless a creator explicitly switches a community to `request`
     * (free — a member asks to join and the owner approves). Validated
     * against that allowlist at the HTTP edge, not by a CHECK constraint —
     * see `z.enum` in `packages/shared/src/community.schema.ts` — the same
     * convention every other status column here follows.
     */
    accessMode: varchar("access_mode", { length: 16 }).notNull().default("paid"),
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
    /**
     * `pending` | `active` | `cancelled` | `superseded`, plus `past_due` and
     * `churned` added in Phase 5. Deliberately a varchar rather than a Postgres
     * enum, so the two new values need no migration of their own — see
     * `schema-phase5.test.ts`, which asserts they physically fit and round-trip.
     */
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    nextBillingDate: date("next_billing_date"),
    /**
     * When this subscription's grace period runs out — set once, when it ENTERS
     * `past_due`, and null at every other time.
     *
     * Stored rather than recomputed on each pass, which is the point. If the job
     * derived the deadline from `next_billing_date` every time it ran, then changing
     * the grace length or the timezone reasoning later would retroactively move the
     * deadline of everybody currently inside their grace period — including members
     * who would be moved into the past and evicted by a config change they never saw.
     * Written down, a deadline is a promise; computed, it is whatever today's code
     * says.
     *
     * Nullable with no default, because a subscription that is not past due has no
     * deadline. A `defaultNow()` here would put every new subscriber a fixed time
     * from eviction.
     *
     * The value written is `max(due date + grace, transition + minimum notice)` — see
     * `computeGraceEndsAt`. The floor exists for the subscription this system meets for
     * the FIRST time long after its due date (every row Phase 4 left behind, on the first
     * pass this phase runs): computed from the due date alone, its deadline would already
     * be in the past and the churn pass would evict it in the same tick that first warned
     * it. The floor does not make the value recomputable — it is still written exactly
     * once, by the transition, and read as stored for ever after.
     */
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
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
    // ===================================================================
    // THE TWO INDEXES PHASE 5'S HOURLY PASSES READ THROUGH.
    //
    // Neither existed when the passes shipped, and a comment in
    // `apps/worker/src/scheduled-passes.ts` claimed both queries were indexed. Live
    // `pg_indexes` on `subscription` held the primary key, `member_id`, `tier_id` and
    // the partial active-unique above and nothing else, so both passes SEQ-SCANNED and
    // SORTED the whole table every hour — and `findDueForRenewal`'s keyset pagination
    // re-scanned it once per page, which is worse the bigger the backlog gets.
    //
    // Column order is (status, date) in both, and that is the useful way round: every
    // status filter here is an equality against a small set and the date is a range, so
    // the leading equality lets the index be scanned rather than merely filtered — and
    // it delivers the rows in the order both queries sort by, which is what removes the
    // sort as well as the scan.
    index("subscription_status_next_billing_date_idx").on(
      table.status,
      table.nextBillingDate
    ),
    // `findPastGraceDeadline`: `status = 'past_due' and grace_ends_at < now`, ordered by
    // the deadline. A far smaller slice of the table than the one above — only members
    // inside their grace period are in it — which is exactly why the seq scan was easy
    // to miss.
    index("subscription_status_grace_ends_at_idx").on(table.status, table.graceEndsAt),
    // ===================================================================
  ],
);

/**
 * A member's request to join a FREE community. The owner approves or rejects
 * it; there is no payment involved, ever — a `join_request` never produces a
 * `transaction` row.
 */
export const joinRequests = pgTable(
  "join_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    tierId: uuid("tier_id")
      .notNull()
      .references(() => membershipTiers.id),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => creators.id),
  },
  (table) => [
    // ONE open request per member per community, arbitrated by the DATABASE rather
    // than by a read-then-write — the same reason `subscription_member_tier_active_unique`
    // is a partial unique index. Two submits in the same instant cannot both win.
    // Decided rows are deliberately outside the index: they are the audit trail, and
    // rejection being silent makes them the only account of what happened.
    uniqueIndex("join_request_community_member_pending_unique")
      .on(table.communityId, table.memberId)
      .where(sql`${table.status} = 'pending'`),
    index("join_request_community_status_idx").on(table.communityId, table.status),
  ],
);

/**
 * One row per reminder stage that has been CLAIMED for a subscription.
 *
 * "Claimed", not "sent": `ProcessRenewals` inserts here and only then enqueues the
 * outbox row, so a row here means "this stage has been dealt with and must never be
 * dealt with again". Usually that means a message was queued and delivered. It also
 * covers the one case where the pass deliberately sends nothing — a community that has
 * been archived — because the claim is what stops a daily pass writing one
 * `renewal_reminder_skipped` audit row per subscription per day, for ever.
 *
 * THIS TABLE IS A LOCK, NOT A LOG. Its reason to exist is the unique
 * `(subscription_id, stage)` below: the reminder pass INSERTS here as the act of
 * claiming the right to send, and the database decides whether that claim is the
 * first one. A pass that runs twice — two workers, a restart mid-pass, a catch-up
 * after downtime — then messages the member exactly once per stage.
 *
 * Doing it the other way round (select, decide, send, insert) is a TOCTOU under
 * READ COMMITTED, in the same shape as the two invite links Phase 4 measured: two
 * passes both read "no reminder yet" and both send. The member gets two WhatsApp
 * messages about the same overdue payment, which reads as either a bug or a dunning
 * campaign, and neither is what we meant.
 */
export const renewalReminders = pgTable(
  "renewal_reminder",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    /**
     * One of `REMINDER_STAGES` in `domain/renewal-schedule.ts` — `pre_3d`, `due`,
     * `overdue_1d`, `overdue_3d`, `overdue_7d`. A varchar rather than an enum, for
     * the same reason `subscription.status` is: adding a stage should not need a
     * migration. `dueStageFor` is what constrains the values in practice.
     */
    stage: varchar("stage", { length: 16 }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * The reminder-once mechanism. It must be IN THE DATABASE, not merely in this
     * file: Drizzle enforces nothing at runtime, so a definition that never reached
     * Postgres would let a duplicate through in silence while the schema still
     * looked correct. `schema-phase5.test.ts` asserts on this constraint's NAME in
     * the raised Postgres error, so a version that exists only here fails the suite.
     *
     * Total, not partial: every stage of every subscription is claimed at most once,
     * and there is no legitimate second send. A subscription that renews and later
     * lapses again is a matter for whoever clears these rows on renewal (Task 6) —
     * an explicit delete, so that re-lapsing sends reminders again by an act rather
     * than by a gap in a predicate.
     */
    uniqueIndex("renewal_reminder_subscription_stage_unique").on(
      table.subscriptionId,
      table.stage
    ),
  ]
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

/**
 * The audit trail, and PHASE 6'S DECLARED SOURCE for analytics.
 *
 * `event_type` is a free varchar, so the vocabulary is a contract held by convention.
 * Phase 5's design spec (§8b, "What this phase leaves in `activity_log`") enumerates every
 * type this phase writes and what each one means; `activity-log-contract.test.ts` fails if
 * the code and that table drift apart. Three things a query has to know, all of which have
 * been got wrong at least once already:
 *
 *  1. ONE REMINDER PRODUCES TWO ROWS — `renewal_reminder_queued` when the stage is claimed,
 *     then `renewal_reminder_sent` when the message actually reaches the provider. Counting
 *     reminders without filtering by `event_type` doubles every figure, and only the second
 *     one means the member was told.
 *  2. `renewed` IS NOT `joined`. A renewal is the same member paying again. Only `markPaid`
 *     can tell them apart, because only it sees the status the row was in before activation.
 *  3. `renewal_reminder` IS A LOCK, NOT A HISTORY. Its rows are DELETED on renewal (see the
 *     table above), so "how many reminders went out last month" must be answered from HERE.
 */
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
    // ===================================================================
    // THE INDEX THE CREATOR DASHBOARD READS THROUGH — measured with
    // EXPLAIN (ANALYZE, BUFFERS) against live PostgreSQL 16.13, 300 000 rows across
    // six communities with 100 000 of them in the one being read.
    //
    // `activity_log` grows with every payment, reminder, grant and revocation, and
    // the activity feed is the most-viewed screen in the product — so this table
    // degrades exactly as a creator becomes successful, which is the worst possible
    // time for it to. It is also the fastest-growing table in the product, which is
    // why the index list below is SHORT: every index here is paid for on every
    // insert, forever, by every creator.
    //
    // (community_id, created_at) — FOR THE FEED. One equality then the range the
    // keyset cursor compares and the order the feed sorts by, so Postgres walks the
    // index BACKWARDS for that community and stops after one page: 0.12 ms and
    // 5 buffers, an Index Scan Backward with no full sort, against 15 ms and 1277
    // buffers with only the two single-column indexes. Two orders of magnitude, and
    // the gap widens with the history, because this is the only one that lets the
    // scan STOP instead of reading everything the community has ever produced. The
    // feed's 8-value `event_type` filter is applied to the ~26 rows a page actually
    // touches, which costs nothing.
    //
    // ---- WHY THERE IS NO (community_id, event_type, created_at) HERE ----
    // There was one, added in Phase 6 Task 1 for a query that does not exist. It was
    // dropped in migration 0015 after the final review, on two independent grounds:
    //
    //  a. NOTHING READS THIS TABLE BY `event_type`. Grep it: the only read in the
    //     whole API is the feed (`DrizzleAnalyticsRepository.listActivityForCreator`);
    //     everything else is `insert`. The metrics and CSV paths read `subscription`
    //     and `transaction`, not this table — an earlier version of this comment said
    //     otherwise and was simply wrong. So the index served nothing and was pure
    //     write amplification on the table that grows fastest.
    //
    //  b. IT MADE THE FEED WORSE, not neutral. The feed's predicate is
    //     `event_type in (<8 values>)`, a ScalarArrayOp on that index's MIDDLE
    //     column, and a btree scan with one of those cannot deliver rows ordered by
    //     the TRAILING column — so it could satisfy neither the ORDER BY nor anything
    //     `community_id` alone did not already do. With ONLY that index present the
    //     feed measured 145 ms / 3676 buffers against 17 ms with no composite index
    //     at all: it lured the planner into a bitmap scan over 50 000 rows.
    //
    // "How many renewal reminders went out last month" — `community_id = ? and
    // event_type = ? and created_at >= ?` — WOULD use it (11.7 ms / 246 buffers when
    // it existed). Add it back in the migration that adds that query, not before.
    // An index kept for an anticipated caller is a cost paid every day for a benefit
    // that may never arrive, and this one was also making today's query slower.
    //
    // This index is not partial on the creator-visible allowlist, deliberately: the
    // visible set is a product decision stated in `domain/activity-feed.ts` and it
    // will change (making a hidden diagnostic visible is a one-line edit), and a
    // partial index would silently stop being used by that edit.
    // ===================================================================
    index("activity_log_community_created_idx").on(table.communityId, table.createdAt),
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
    /**
     * Set when a caller ENTERS the mint window, cleared when it leaves — the marker
     * that makes "claimed, no link" an unambiguous state instead of a guess.
     *
     * THE CREDENTIAL-LIFECYCLE INVARIANT this column exists to enforce: at most one
     * live invite link per (member, channel) may exist at the provider at any time,
     * and every link that exists is recorded in `invite_link`.
     *
     * Without it, `invite_link IS NULL` on a claimed row conflates three different
     * situations: nobody has minted yet, somebody minted and could not record it, and
     * somebody is minting right now. `GrantChannelAccess` read all three as "finish
     * the grant" and minted a fresh link for each, so a `recordGrant` that failed on
     * every bounded retry left FIVE live single-use links at Telegram behind one row
     * whose `invite_link` was NULL — five credentials the system had no record of and
     * therefore no way to revoke. Measured, before this column existed.
     *
     * So: link is null + this is NOT null means A LINK MAY BE LIVE AND UNRECORDED.
     * Minting another would stack a second credential on an orphan we cannot kill
     * (Telegram's `revokeChatInviteLink` needs the link's value, and no Bot API method
     * enumerates a bot's links), so the grant FAILS CLOSED — reported to the member as
     * manual addition and to the creator in `activity_log`, for a deliberate reissue.
     *
     * "MAY BE" IS EXACT, AND THE COLUMN HAS TO BE CLEARED WHENEVER IT CANNOT BE. It is
     * cleared by `recordGrant` on success, and by `releaseMintWindow` in the two states
     * where no credential can exist: a lost link that WAS revoked at the provider, and
     * a `grantAccess` that failed with an HTTP response received, which mints nothing.
     * Leaving it set in that second case cost a paying member their access
     * PERMANENTLY — one transient Telegram failure, then a healthy provider, and every
     * later attempt reported `mint_lost` with no reissue tool to clear it. Measured.
     */
    linkMintedAt: timestamp("link_minted_at", { withTimezone: true }),
    /**
     * How long the caller inside the mint window holds it. Set with
     * `link_minted_at`, in the SAME statement as the claim.
     *
     * IT DOES NOT PROVIDE SERIALIZATION, and an earlier version of this comment
     * claiming it did was wrong in a way worth correcting: a misleading invariant
     * comment is how the next person removes the wrong thing.
     *
     * MUTUAL EXCLUSION COMES FROM `link_minted_at` BEING WRITTEN IN THE CLAIM ITSELF.
     * The second of two callers arriving together has its `DO UPDATE` predicate
     * re-evaluated against the locked, already-updated tuple, finds `link_minted_at`
     * non-null, and is excluded — no lease consulted, no read, nothing to race. (The
     * measured two-live-links case was the version that checked the marker in a
     * SEPARATE statement from the claim; both callers read NULL and both minted.)
     *
     * WHAT THIS COLUMN DOES IS CLASSIFY THE EXCLUDED CALLER, which is the difference
     * between a retry and a manual reissue and therefore between a member who gets
     * their link a second later and one who waits for a person:
     *
     *   marker + live lease   -> `mint_in_progress`  the holder is mid-flight; RETRY
     *   marker + lapsed lease -> `mint_lost`         a link may be live and unrecorded;
     *                                                FAIL CLOSED, report for reissue
     *
     * A LEASE rather than `pg_advisory_xact_lock` because the window spans an
     * external HTTP call: an advisory lock would have to be held in an open
     * transaction across the provider round-trip, pinning a pooled connection to a
     * hung Telegram. A lease needs no transaction and is visible to an operator in
     * the row.
     *
     * Its expiry FAILS CLOSED: a second caller arriving after it lapses sees the
     * marker still set and reports "minted and lost" rather than minting. So a lease
     * that is too short costs a spurious manual report, never a second credential —
     * which follows from exclusion living in the marker, not here.
     *
     * Cleared alongside `link_minted_at`: by `recordGrant` on success, and by
     * `releaseMintWindow` whenever no credential can exist — a lost link that WAS
     * revoked at the provider, or a `grantAccess` that failed with a response received
     * (nothing was minted). Left SET only where a link may be live and unheld.
     */
    mintLeaseUntil: timestamp("mint_lease_until", { withTimezone: true }),
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

export const aiConversations = pgTable(
  "ai_conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ai_conversation_creator_idx").on(table.creatorId, table.createdAt)]
);

export const aiMessages = pgTable(
  "ai_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => aiConversations.id),
    role: varchar("role", { length: 16 }).notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ai_message_conversation_idx").on(table.conversationId, table.createdAt)]
);

/**
 * One row per creator per UTC day. UNIQUE (creator_id, usage_date) is what lets
 * the cap be enforced by a single upsert — two concurrent requests cannot both
 * pass a limit with one slot left, because the database arbitrates rather than
 * a read-then-write in application code.
 */
export const aiUsage = pgTable(
  "ai_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => creators.id),
    usageDate: date("usage_date").notNull(),
    messageCount: integer("message_count").notNull().default(0),
  },
  (table) => [uniqueIndex("ai_usage_creator_date_unique").on(table.creatorId, table.usageDate)]
);

/**
 * Task 1 of the profiles-and-following phase: one row per (follower, followee)
 * pair. Unidirectional — Alice following Bob is one row, and Bob following
 * Alice back (if it ever happens) is a second, independent row.
 */
export const follows = pgTable(
  "follow",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    followerId: uuid("follower_id")
      .notNull()
      .references(() => appUsers.id),
    followeeId: uuid("followee_id")
      .notNull()
      .references(() => appUsers.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Following twice is ONE row, arbitrated by the database rather than by a
    // read-then-write — the same reason `join_request_community_member_pending_unique`
    // is a unique index. Two taps in the same instant cannot both insert.
    uniqueIndex("follow_follower_followee_unique").on(table.followerId, table.followeeId),
    // BOTH directions are read on every profile view: "who follows this person"
    // and "who they follow". Missing indexes on exactly this shape left the
    // renewal passes seq-scanning for a whole phase before anyone noticed.
    index("follow_followee_created_idx").on(table.followeeId, table.createdAt),
    index("follow_follower_created_idx").on(table.followerId, table.createdAt),
    // A CHECK, not only a use-case guard, so it holds however the row arrives —
    // a future bulk import, a manual fix, a second call site.
    check("follow_no_self", sql`${table.followerId} <> ${table.followeeId}`),
  ],
);

export const posts = pgTable(
  "post",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => appUsers.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set on edit, null otherwise. Drives PostCard's `· diedit` marker, which is
    // the whole of "a reader can tell a post changed" — there is no edit history.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // SOFT delete. Every read path must filter this, and the spec (§4.2) names a
    // filter present on three paths and missing on the fourth as this phase's
    // single biggest risk: each path's own tests only ever create live posts, so
    // nothing goes red.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Untuk Anda: newest first across everybody. PARTIAL, so deleted rows leave
    // the hot index entirely rather than being filtered out of every scan.
    index("post_live_created_idx")
      .on(table.createdAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null`),
    // A profile's posts, and the post side of the Mengikuti join.
    index("post_author_created_idx").on(table.authorId, table.createdAt.desc()),
  ]
);

export const postMedia = pgTable(
  "post_media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The uploader. Kept even after the post claims the row: an edit has to
    // check that the media it is being handed belongs to the editor, and the
    // post it currently sits on is not the answer to that question.
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => appUsers.id),
    // NULLABLE, and this is the whole two-step upload in one column. A row
    // exists from the moment bytes land, before any post does, and is CLAIMED
    // when the post is created or edited. A null here is an orphan and the
    // worker's sweep collects it (spec §8).
    postId: uuid("post_id").references(() => posts.id),
    // 0-based, and only meaningful once claimed. The order the client sent.
    position: integer("position").notNull().default(0),
    // Of the FULL image after re-encoding, not of what was uploaded. PostCard
    // reserves space from these so the feed does not reflow as images land.
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The post's own images, in order. Covers the read on every feed row.
    index("post_media_post_position_idx").on(table.postId, table.position),
    // The sweep: unclaimed rows, oldest first. PARTIAL, so claimed rows — which
    // are the overwhelming majority — never enter this index at all.
    index("post_media_unclaimed_idx")
      .on(table.createdAt)
      .where(sql`${table.postId} is null`),
  ]
);

/**
 * Task 1 of Phase 5a: a membership tier a user offers on their own profile —
 * separate from, and unrelated to, `membership_tier` under `/dashboard/*`.
 */
export const userTiers = pgTable(
  "user_tier",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => appUsers.id),
    name: varchar("name", { length: 128 }).notNull(),
    // Integer rupiah, matching `membership_tier.price_amount`'s convention.
    priceAmount: integer("price_amount").notNull(),
    // varchar, not an enum, so 5b can add cycles without a migration — the same
    // reasoning `subscription.status` records for `past_due`/`churned`.
    billingCycle: varchar("billing_cycle", { length: 16 }).notNull(),
    // A deactivated tier stops being offered. Existing subscriptions to it are
    // unaffected — see the spec's §4.
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("user_tier_owner_idx").on(table.ownerId),
    // Redundant on its own — `id` is already unique. It exists ONLY so
    // `user_subscription` can carry a composite foreign key against
    // (id, owner_id), which is what makes its denormalised `owner_id`
    // impossible to falsify. Do not remove it as "duplicate".
    uniqueIndex("user_tier_id_owner_unique").on(table.id, table.ownerId),
  ]
);

/**
 * Task 2 of Phase 5a: what a paid membership actually is — one row per
 * (subscriber, owner) relationship over time. Separate from, and unrelated
 * to, `subscription` under `/dashboard/*`.
 */
export const userSubscriptions = pgTable(
  "user_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => appUsers.id),
    tierId: uuid("tier_id").notNull(),
    /**
     * DENORMALISED from the tier, and kept honest by the composite foreign key
     * below rather than by anyone remembering. Phase 6 asks "is this viewer a
     * member of that person" on every gated post, and that must be one index
     * hit, not a join through the tier.
     */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => appUsers.id),
    /** `pending` | `active` | `cancelled`. 5b adds `past_due` and `churned`. */
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The whole point of `user_tier_id_owner_unique`: a subscription whose
    // owner disagrees with its tier's owner CANNOT BE INSERTED. No trigger, no
    // application invariant anyone can forget.
    foreignKey({
      columns: [table.tierId, table.ownerId],
      foreignColumns: [userTiers.id, userTiers.ownerId],
      name: "user_subscription_tier_owner_fk",
    }),
    // You cannot subscribe to yourself, exactly as `follow_no_self` forbids
    // following yourself.
    check("user_subscription_no_self", sql`${table.subscriberId} <> ${table.ownerId}`),
    // Nobody holds two live memberships to the same person — which is the
    // shape of accidentally paying twice.
    uniqueIndex("user_subscription_one_active")
      .on(table.subscriberId, table.ownerId)
      .where(sql`${table.status} = 'active'`),
    index("user_subscription_owner_idx").on(table.ownerId),
  ]
);

export const userTransactions = pgTable("user_transaction", {
  id: uuid("id").primaryKey().defaultRandom(),
  userSubscriptionId: uuid("user_subscription_id")
    .notNull()
    .references(() => userSubscriptions.id),
  // What WE believe is owed. The webhook compares the provider's claim against
  // this and never the other way round — see `handle-payment-webhook.ts`'s own
  // docstring for why that direction is the security property.
  amount: integer("amount").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  gatewayReferenceId: varchar("gateway_reference_id", { length: 255 }),
  /**
   * The provider's own hosted payment page for this transaction, stored so a
   * buyer who taps "Jadi anggota" twice is handed BACK the invoice already
   * waiting for them instead of being sold a second one (Phase 5a fix round 1,
   * F2). Two live invoices for one membership are two chargeable invoices, and
   * 5a has no refund path.
   *
   * Nullable and written in the same statement as `gateway_reference_id`, after
   * the provider call returns: NULL therefore means "no invoice was ever opened
   * for this attempt", which is exactly the state a failed provider call leaves
   * behind and the state that must NOT block a fresh attempt.
   */
  gatewayInvoiceUrl: varchar("gateway_invoice_url", { length: 512 }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
