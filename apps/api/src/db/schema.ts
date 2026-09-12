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
 * PHASE 1 ("communities-core") DROPPED THE COMMUNITY-CENTRIC MODEL HERE.
 *
 * Eighteen tables — `creator` down through `enrollment`, plus the three
 * creator-scoped `ai_*` tables — belonged to a retired product generation with
 * no live reader: every route, use-case, port and repository above them had
 * already been deleted across four earlier commits, leaving `test-helpers.ts`
 * as their only importer. `creator` was a separate identity from `app_user`
 * with no foreign key and no login path since c8c5046 removed it, so the set
 * could not be revived in place — Phase 1 needs communities owned by
 * `app_user`s instead. See the migration that dropped them and
 * `.superpowers/sdd/2026-09-10-communities-core/task-1-report.md` for the
 * full accounting.
 */

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
    // `public` | `members`. VARCHAR, not an enum — the reasoning
    // subscription.status already records: a later value needs no migration.
    // The DEFAULT is load-bearing: it makes this migration additive and turns
    // every existing post public, which is the only safe direction.
    visibility: varchar("visibility", { length: 16 }).notNull().default("public"),
    // Phase 2. NULL means a personal post — Beranda and profiles. NOT NULL
    // means a community post, which appears on its community page and
    // nowhere else. There is no third state and nothing infers one from
    // the other.
    communityId: uuid("community_id").references(() => communities.id),
    // `diskusi` | `pengumuman`. VARCHAR, not an enum, so Phase 3's
    // `kegiatan` and Phase 4's `materi`/`dokumen` need no migration — the
    // reasoning `subscription.status` already records.
    type: varchar("type", { length: 16 }).notNull().default("diskusi"),
  },
  (table) => [
    // Untuk Anda: newest first across everybody. PARTIAL on BOTH conditions,
    // so deleted rows AND community rows leave the hot index entirely rather
    // than being filtered out of every scan. Phase 2 added the second
    // condition when Beranda became `community_id IS NULL`.
    index("post_live_created_idx")
      .on(table.createdAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null and ${table.communityId} is null`),
    // A profile's posts, and the post side of the Mengikuti join. BOTH
    // consumers exclude community posts, so the filter belongs in the index.
    index("post_author_created_idx")
      .on(table.authorId, table.createdAt.desc())
      .where(sql`${table.deletedAt} is null and ${table.communityId} is null`),
    // Phase 2: the community feed's keyset page.
    index("post_community_created_idx")
      .on(table.communityId, table.createdAt.desc(), table.id.desc())
      .where(sql`${table.deletedAt} is null`),
    // A personal post has no type: types are a community concept, and a
    // personal row carrying `pengumuman` is a row no surface renders.
    check("post_personal_has_no_type", sql`${table.communityId} is not null or ${table.type} = 'diskusi'`),
    // DO NOT DELETE THIS AS BELT-AND-BRACES. `visibility = 'members'` is the
    // PERSONAL paywall: `paginate()` in read-posts.ts resolves it against
    // `user_tier` subscriptions via `listActiveOwnersAmong`. A community post
    // carrying `members` would be gated against the author's personal tier,
    // which has no relationship to the community it is in — a member of the
    // community would be locked OUT of it, and a subscriber to the author who
    // never joined would be let IN. A community post's audience is the
    // community; this column must not be made to mean anything else here.
    check("post_community_is_public", sql`${table.communityId} is null or ${table.visibility} = 'public'`),
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
 * Phase 2. FLAT — no `parent_id`. The programme's feature list says "threaded
 * comments"; the spec records the deviation and its reason. `parent_id` can
 * be added later as a nullable column without moving a row.
 */
export const postComments = pgTable(
  "post_comment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id),
    authorId: uuid("author_id")
      .notNull()
      .references(() => appUsers.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Present from the start so a comment's lifecycle needs no second
    // migration. NOTHING WRITES IT THIS PHASE — there is no edit endpoint.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // SOFT delete, matching `post`. Every read path must filter it.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // The thread, oldest first. PARTIAL: deleted comments leave the index.
    index("post_comment_post_created_idx")
      .on(table.postId, table.createdAt)
      .where(sql`${table.deletedAt} is null`),
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
    // Phase 5. NULL means a PERSONAL tier — a tier on somebody's profile,
    // which is what every row predating this column is, and what nothing in
    // this phase changes. Non-null means a COMMUNITY tier.
    //
    // One column rather than a `community_tier` table, for the reason Phase 2
    // recorded when community posts reused `post`: the invoice path, the
    // webhook, `user_transaction`, the five renewal passes and
    // `membership_reminder` are reused untouched, and the alternative is
    // Phases 5a and 5b rebuilt beside themselves.
    //
    // `ownerId` stays the PAYOUT destination either way; for a community tier
    // it is the community's owner, which is what keeps
    // `user_subscription_tier_owner_fk` holding unchanged.
    communityId: uuid("community_id").references(() => communities.id),
  },
  (table) => [
    index("user_tier_owner_idx").on(table.ownerId),
    // The community's offer — `GET /communities/:slug/tiers`. PARTIAL on
    // non-null, so every personal tier (which is every row today) stays out
    // of this index entirely.
    index("user_tier_community_idx")
      .on(table.communityId)
      .where(sql`${table.communityId} is not null`),
    // Redundant on its own — `id` is already unique. It exists ONLY so
    // `user_subscription` can carry a composite foreign key against
    // (id, owner_id), which is what makes its denormalised `owner_id`
    // impossible to falsify. Do not remove it as "duplicate".
    uniqueIndex("user_tier_id_owner_unique").on(table.id, table.ownerId),
    // Phase 5, and redundant on its own for the same reason the index above
    // is: `id` is already unique. It exists ONLY so `user_subscription` can
    // carry a composite foreign key against (id, community_id), which is what
    // makes ITS denormalised `community_id` impossible to falsify — the exact
    // trick `user_tier_id_owner_unique` plays for `owner_id`. Do not remove it
    // as "duplicate".
    uniqueIndex("user_tier_id_community_unique").on(table.id, table.communityId),
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
    /**
     * `pending` | `active` | `cancelled` | `expired`. Still a varchar rather
     * than an enum, so `expired` — retirement's target status, see
     * `DrizzleUserSubscriptionRepository.retireExpired` — needed no migration
     * to add, and any future status added here won't either.
     */
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    // 'paid' | 'free'. VARCHAR, not an enum — same reasoning as `status` above
    // and `post.visibility`: a later value needs no migration. The DEFAULT makes
    // this migration additive and leaves every existing row paid, which is what
    // every existing row is.
    kind: varchar("kind", { length: 16 }).notNull().default("paid"),
    // Phase 5. NULL means a PERSONAL membership — a subscription to the person
    // named by `owner_id`, which is every row predating this column. Non-null
    // means a membership OF THAT COMMUNITY.
    //
    // DENORMALISED from `user_tier.community_id`, and this one is not a
    // judgement call: `user_subscription_one_active` is a partial unique index
    // and an index cannot reach through a join. Without the column here, a
    // community tier's owner being a person who also sells personal tiers made
    // a perfectly reasonable second purchase violate that index. It is kept
    // honest by `user_subscription_tier_community_fk` below rather than by
    // anyone remembering to write it.
    communityId: uuid("community_id").references(() => communities.id),
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
    // Phase 5's equivalent for the community. A row whose `community_id`
    // disagrees with its tier's CANNOT BE INSERTED — including a PERSONAL
    // tier (community_id NULL) sold as a community membership, which fails
    // because no `user_tier` row has that (id, community_id) pair.
    //
    // A NULL in either column makes a MATCH SIMPLE foreign key unenforced,
    // which is exactly right here: a personal subscription to a personal tier
    // is (NULL, NULL) and has nothing to falsify.
    foreignKey({
      columns: [table.tierId, table.communityId],
      foreignColumns: [userTiers.id, userTiers.communityId],
      name: "user_subscription_tier_community_fk",
    }),
    // You cannot subscribe to yourself, exactly as `follow_no_self` forbids
    // following yourself.
    check("user_subscription_no_self", sql`${table.subscriberId} <> ${table.ownerId}`),
    // Nobody holds two live memberships to the same person — which is the
    // shape of accidentally paying twice.
    // `community_id` JOINS THE KEY (Phase 5) — a community tier's owner is a
    // person who may also sell personal tiers, so without it a perfectly
    // reasonable second purchase violated this index. READ THE INDEX BELOW
    // TOO: this one alone does not hold the personal case.
    uniqueIndex("user_subscription_one_active")
      .on(table.subscriberId, table.ownerId, table.communityId)
      .where(sql`${table.status} = 'active'`),
    // AND ITS OTHER HALF, which is not optional. Postgres treats NULLs as
    // DISTINCT in a unique index, so the index above does NOT constrain
    // personal rows at all — two of them, each with a NULL community, both
    // pass it. `NULLS NOT DISTINCT` says what is meant and needs PG 15, but
    // drizzle 0.45's pg builder does not expose it, and an expression index
    // (coalescing the NULL to a sentinel) cannot be named as an `ON CONFLICT`
    // target, which `claimPending` depends on.
    //
    // So the personal case gets its own partial index. Two plain indexes,
    // each targetable, together meaning exactly "one live membership per
    // (subscriber, scope)".
    uniqueIndex("user_subscription_one_active_personal")
      .on(table.subscriberId, table.ownerId)
      .where(sql`${table.status} = 'active' and ${table.communityId} is null`),
    /**
     * AND NOBODY HOLDS TWO PENDING ONES EITHER — the same shape, one step
     * earlier, and the one that actually happens.
     *
     * Fix round 2. `StartUserSubscription` already refused a second checkout by
     * READING for a pending one first, and a re-review fired two concurrent
     * `POST /subscribe` calls at the real database: four runs serialised, the
     * fifth produced two live invoices, two subscriptions and two transactions
     * for the identical pair. A double tap on a phone is concurrent, not
     * sequential, and an application-level read-then-write cannot win a race it
     * does not arbitrate — the same conclusion Task 2's constraints and Task 3's
     * claim-first sentinel each reached before it.
     *
     * So the INSERT is the claim: exactly one caller can hold a pair's pending
     * slot, everybody else gets `23505` on this index and is routed into the
     * reuse path instead of a second invoice. Partial, like the `active` one
     * above, so a settled or cancelled subscription never blocks a later
     * purchase.
     */
    // Scoped the same way and for the same reason — see the active pair above.
    uniqueIndex("user_subscription_one_pending")
      .on(table.subscriberId, table.ownerId, table.communityId)
      .where(sql`${table.status} = 'pending'`),
    // AND ITS OTHER HALF, which is not optional. Postgres treats NULLs as
    // DISTINCT in a unique index, so the index above does NOT constrain
    // personal rows at all — two of them, each with a NULL community, both
    // pass it. `NULLS NOT DISTINCT` says what is meant and needs PG 15, but
    // drizzle 0.45's pg builder does not expose it, and an expression index
    // (coalescing the NULL to a sentinel) cannot be named as an `ON CONFLICT`
    // target, which `claimPending` depends on.
    //
    // So the personal case gets its own partial index. Two plain indexes,
    // each targetable, together meaning exactly "one live membership per
    // (subscriber, scope)".
    uniqueIndex("user_subscription_one_pending_personal")
      .on(table.subscriberId, table.ownerId)
      .where(sql`${table.status} = 'pending' and ${table.communityId} is null`),
    index("user_subscription_owner_idx").on(table.ownerId),
    /**
     * Task 3 of Phase 5b (the retirement sweep): the covering index Task 1's review
     * flagged and deliberately deferred, because Task 1 was explicitly a no-migration
     * task and the table held zero rows either way. Task 3 is the task that actually
     * SCANS through `listExpiredActive` every hour — see
     * `apps/worker/src/scheduled-passes.ts`'s `SweepExpiredMemberships` — so it is the
     * one that owns the cost of not having this.
     *
     * COLUMN ORDER MIRRORS `subscription_status_next_billing_date_idx` (migration
     * 0012, Phase 5's own hourly passes): `status` leads because the query's equality
     * against it (`status = 'active'`) is what makes the index selective at all — most
     * rows in this table are not `active` forever, they pass through it — and
     * `current_period_end` trails because the query's other predicate on it is a
     * RANGE (`<= now`), which only a trailing column can serve. Leading with the range
     * column instead would make the index useless for the equality filter.
     *
     * NOT PARTIAL. A partial index `WHERE status = 'active'` would look tighter, but
     * this project already carries two partial indexes on this exact table
     * (`user_subscription_one_active`, `user_subscription_one_pending`) whose WHERE
     * clauses are load-bearing security/correctness properties, not query-planner
     * fuel — mixing a third, purely-for-speed partial index into the same list of
     * `(table) => [...]` entries is exactly the kind of place this project has
     * previously lost a day to drizzle silently dropping a `.where(...)` modifier
     * nobody caught. A plain composite index needs no such trust: its presence and its
     * column order are both directly legible from `pg_indexes`, which is what
     * `schema-phase5b.test.ts` reads rather than trusting this comment.
     */
    index("user_subscription_status_current_period_end_idx").on(
      table.status,
      table.currentPeriodEnd
    ),
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

/**
 * Task 4 of Phase 5b: the "remind a member once before their membership ends"
 * claim.
 *
 * THIS TABLE IS A LOCK FIRST AND A RECORD SECOND, and the order matters. Its
 * reason to exist is the unique index below: the reminder pass INSERTS here as
 * the act of claiming the right to send, and the database decides whether that
 * claim is the first one. A pass that runs twice — two workers, a restart
 * mid-pass, an hourly loop crossing a three-day reminder window twenty-four
 * times a day — then messages the member exactly once.
 *
 * Doing it the other way round (select, decide, send, insert) is a TOCTOU under
 * READ COMMITTED. `renewal_reminder`'s own docstring records the same shape and
 * the same measurement (Phase 4's two live invite links for one paying member);
 * Phase 5b has now reached "the database must arbitrate" in four separate tasks.
 *
 * WHY THERE IS NO `stage` COLUMN, unlike `renewal_reminder`. That table's key is
 * `(subscription_id, stage)` because a community subscription is a LONG-LIVED row
 * that lapses, is chased four times, renews, and can lapse again — so its claims
 * have to be cleared on renewal by an explicit delete. A `user_subscription` never
 * renews: there is no recurring charge anywhere in this system, so "renewal" means
 * "buy again", and buying again retires the old row (`status = 'expired'`) and
 * INSERTS A NEW ONE with a new id. One membership, one ending, one reminder — and a
 * member who buys again gets a fresh row here for their fresh membership, with no
 * cleanup pass to forget to write.
 */
export const membershipReminders = pgTable(
  "membership_reminder",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userSubscriptionId: uuid("user_subscription_id").notNull(),
    /**
     * What became of the claim — the audit trail this table doubles as, because
     * `activity_log` cannot serve here: its `community_id` is `NOT NULL` and
     * references `community`, one of the untouchable `/dashboard/*` tables, and an
     * `app_user` membership has no community at all.
     *
     * One of `MEMBERSHIP_REMINDER_OUTCOMES` in
     * `application/ports/membership-reminder-repository.port.ts`; a varchar rather
     * than an enum, for the same reason `user_subscription.status` is.
     *
     * IT DEFAULTS TO `claimed` AND THAT IS THE POINT: the claim is written before
     * anything is sent, so `claimed` is what a row says when the process died
     * between claiming and delivering. `no_channel` is the deliberate skip — "the
     * member was never told" is the failure mode this whole pass exists to prevent,
     * so the one case where it is intentional has to be visible rather than look
     * identical to a pass that reached everybody.
     *
     * IT IS ALSO READ, not merely written: `no_channel` is the one value that lets a
     * later pass RE-CLAIM the row, because that value records a deployment with no
     * email provider rather than a member who cannot be reached (`app_user.email` is
     * `NOT NULL UNIQUE`). See `MembershipReminderRepositoryPort.claim`, which puts the
     * predicate in the `ON CONFLICT ... DO UPDATE`'s own `WHERE` so the database
     * still decides.
     */
    outcome: varchar("outcome", { length: 24 }).notNull().default("claimed"),
    /**
     * Which channels actually took the message, comma-joined (`email`,
     * `email,whatsapp`, `whatsapp`), or NULL when none did. Counts and channel
     * names only — never an address, never a number, never the message body. Read
     * by an operator asking "reached by what", which the outcome alone cannot say.
     */
    channels: varchar("channels", { length: 32 }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // NAMED EXPLICITLY rather than left to drizzle's `references(...)` shorthand,
    // which derives `membership_reminder_user_subscription_id_user_subscription_id_fk`
    // — 64 characters, one past Postgres's identifier limit, so every migration of a
    // fresh database emitted a `will be truncated` NOTICE and the constraint's real
    // name differed from the one in the migration file.
    foreignKey({
      columns: [table.userSubscriptionId],
      foreignColumns: [userSubscriptions.id],
      name: "membership_reminder_subscription_fk",
    }),
    /**
     * The remind-once mechanism, and it must be IN THE DATABASE rather than merely
     * in this file: drizzle enforces nothing at runtime, so a definition that never
     * reached Postgres would let a second send through in silence while the schema
     * still looked correct. A missing — or merely non-unique — index turns "claim
     * before send" into "send twice" and NOTHING FAILS.
     *
     * `schema-phase5b.test.ts` therefore reads `pg_indexes` for this name and
     * asserts UNIQUE, and `drizzle-membership-reminder.repository.test.ts` proves
     * the arbitration by making five callers claim the same subscription at once.
     *
     * Total, not partial: every membership is claimed at most once, ever, and there
     * is no legitimate second send for the same row (see the table docstring for
     * why a re-lapse is a different row).
     */
    uniqueIndex("membership_reminder_subscription_unique").on(table.userSubscriptionId),
  ]
);

/**
 * Task 1 of Phase 7: one broadcast a person is running, or has run, on their
 * own profile — a NEW, user-scoped table beside the old world's `event`
 * (community-scoped, untouchable), never a generalisation of it. See the
 * design spec's §4.1 for why: `event.community_id` references `community`,
 * one of the untouchable `/dashboard/*` tables, and an `app_user` broadcast
 * has no community at all — the same argument Phase 5a made for `user_tier`
 * and `user_subscription`, with the same payoff: Phase 8 becomes a deletion
 * rather than an untangling.
 */
export const userStreams = pgTable(
  "user_stream",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => appUsers.id),
    title: varchar("title", { length: 140 }).notNull(),
    // Same column type and values as `post.visibility`, for the same reason:
    // a varchar so a later value needs no migration.
    visibility: varchar("visibility", { length: 16 }).notNull().default("public"),
    // The publish secret, from `newStreamKey()`. NEVER logged — see
    // `handle-stream-lifecycle.ts`'s docstring for the rule this table
    // inherits unchanged.
    streamKey: varchar("stream_key", { length: 128 }).notNull().unique(),
    status: varchar("status", { length: 16 }).notNull().default("live"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    // ONE live stream per person, arbitrated by the database. PARTIAL, so an
    // ended stream frees the slot — without the WHERE, a creator could
    // stream exactly once, ever, and be blocked forever by their own
    // history. See the design spec's §4 and the Task 1 report for the
    // mutants that pin this clause down.
    uniqueIndex("user_stream_one_live")
      .on(table.ownerId)
      .where(sql`${table.status} = 'live'`),
    // Siaran's listing: live rows, newest first.
    index("user_stream_live_started_idx")
      .on(table.startedAt.desc())
      .where(sql`${table.status} = 'live'`),
  ]
);

/**
 * A viewer's "still here" — recorded through nginx's `/auth-request`, which
 * already fires on every HLS request (see `mediamtx-webhooks.ts`'s own
 * docstring), rather than through any new MediaMTX hook. `identity` is a
 * token's `viewerId` for a members-only read, or `anonymousViewerIdentity`'s
 * hash for a public one (which carries no token at all) — see
 * `domain/anonymous-viewer-identity.ts`.
 *
 * One row per (stream, identity), upserted — never one row per request, or
 * this table would grow at the rate of every HLS segment fetch on the
 * platform. `GET /streams` counts DISTINCT identities per stream with
 * `last_seen_at` inside `VIEWER_HEARTBEAT_WINDOW_MS` (`stream-views.ts`) as
 * that stream's live viewer count; `SweepStaleViewerHeartbeats`
 * (`apps/worker`) deletes rows well past that window so the table stays
 * bounded.
 */
export const streamViewerHeartbeats = pgTable(
  "stream_viewer_heartbeat",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    streamId: uuid("stream_id")
      .notNull()
      .references(() => userStreams.id),
    // A viewer-token's `viewerId` (a uuid), or a sha256 hex hash — 64
    // characters covers either verbatim.
    identity: varchar("identity", { length: 64 }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // What makes recording a heartbeat an UPSERT rather than a new row per
    // request.
    uniqueIndex("stream_viewer_heartbeat_stream_identity_unique").on(
      table.streamId,
      table.identity
    ),
    // The count query's own index: distinct identities for a stream, filtered
    // to `last_seen_at >= since`.
    index("stream_viewer_heartbeat_stream_last_seen_idx").on(table.streamId, table.lastSeenAt),
  ]
);

/**
 * A community owned by an `app_user`.
 *
 * This is NOT the `community` table that was dropped in Phase 1. That one hung
 * off `creator`, a separate identity with no relationship to `app_user` and no
 * login path since its routes were deleted. The name is reused because the
 * table it named is gone and the product's central concept should have it.
 */
export const communities = pgTable(
  "community",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => appUsers.id),
    name: varchar("name", { length: 120 }).notNull(),
    slug: varchar("slug", { length: 60 }).notNull().unique(),
    category: varchar("category", { length: 64 }).notNull(),
    description: varchar("description", { length: 300 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Discover browse data. A native array, not a join table: nothing here
    // needs a tag as its own row (no tag-scoped, paginated browse), only a
    // membership check per community and a global frequency count, and
    // `unnest()` answers both directly.
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  },
  (table) => [
    index("community_owner_idx").on(table.ownerId),
    // The browse page's default listing is "newest in this category", and its
    // unfiltered listing is "newest overall" — the leading column is skipped
    // for the second, which Postgres allows at a cost this table's size makes
    // irrelevant.
    index("community_category_created_idx").on(table.category, table.createdAt),
  ]
);

/**
 * Membership. One row per person per community, including the owner — a
 * community with no members is not a state this app can reach, because
 * `CreateCommunity` writes both rows in one transaction.
 */
export const communityMembers = pgTable(
  "community_member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id),
    role: varchar("role", { length: 16 }).notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Joining is idempotent through this: the repository uses
    // onConflictDoNothing on these two columns rather than catching a 23505.
    uniqueIndex("community_member_unique").on(table.communityId, table.userId),
    // "which communities am I in" — the sidebar and the browse page's
    // viewer-is-member marking both read this way.
    index("community_member_user_idx").on(table.userId),
    index("community_member_community_joined_idx").on(table.communityId, table.joinedAt),
  ]
);

/**
 * Phase 3. The when-and-where of a `post` whose `type` is `kegiatan` — the
 * post itself carries the description, the author, the media, the soft delete
 * and the comment thread.
 *
 * `post_id` IS the primary key, not a column beside a separate `id`. The
 * relationship is 1:1 and the post is the identity: the detail URL, the
 * comment thread and the owner's moderation all key off it, and a second id
 * would be a second name for the same thing.
 *
 * NO `created_at`, `edited_at` or `deleted_at`. The post has all three, every
 * read path here joins it, and a lifecycle of its own is a lifecycle that can
 * disagree with the post's.
 */
export const communityEvents = pgTable(
  "community_event",
  {
    postId: uuid("post_id")
      .primaryKey()
      .references(() => posts.id),
    // DUPLICATES `post.community_id`, deliberately. The calendar's only query
    // is "this community's events between two instants"; without this column
    // that means walking the community's whole post history to find the
    // handful that are events. Both rows are written in one transaction
    // (`CreatePost`'s unit of work), so they cannot drift, and nothing reads
    // this to decide which community owns a post — it exists to be ranged over.
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    // Separate from `post.body`: a `diskusi` has no title and `PostCard`
    // renders none, so a nullable `title` on `post` would put the unused
    // column on the hot table instead of the cold one.
    title: varchar("title", { length: 160 }).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    location: varchar("location", { length: 200 }),
  },
  (table) => [
    // The calendar's month range and the agenda's ordering, in one. No partial
    // WHERE: there is no soft-delete column here, and the `post.deleted_at`
    // filter lands on the joined side.
    index("community_event_community_starts_idx").on(table.communityId, table.startsAt),
    // A CHECK and not only a use-case guard, the reason `follow_no_self`
    // records: it holds however the row arrives. `>` and not `>=` — a
    // zero-length event is a data-entry slip the composer's own time fields
    // make easy to produce.
    check(
      "community_event_ends_after_starts",
      sql`${table.endsAt} is null or ${table.endsAt} > ${table.startsAt}`
    ),
  ]
);

/**
 * Phase 4b. One week, module or chapter of a community's syllabus.
 *
 * `position` is supplied by the AUTHOR, not computed from `created_at`: a
 * syllabus is ordered by whoever wrote it, and a creation-time order would
 * make inserting a week between two others impossible without rewriting
 * timestamps.
 */
export const courseSections = pgTable(
  "course_section",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    title: varchar("title", { length: 160 }).notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("course_section_community_position_idx").on(table.communityId, table.position),
  ]
);

/**
 * Phase 4b. One lesson: a title, a body, and optionally ONE document from the
 * community's Phase 4a library.
 *
 * **No `type` column.** There is exactly one kind of lesson. A column whose
 * only value is `"text"` is a column that invites somebody to add `"video"`
 * before anything can serve one — and hosted video is still the unresolved
 * large-file decision Phase 4a deferred. When it arrives it brings its own
 * column and its own migration.
 *
 * The attachment is where every rule about files already lives: the 25 MB
 * cap, the format allowlist, the `attachment`/`nosniff` headers and the
 * members-only gate are all `community_document`'s, and a lesson inherits
 * them rather than restating any of them.
 */
export const courseLessons = pgTable(
  "course_lesson",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => courseSections.id),
    title: varchar("title", { length: 160 }).notNull(),
    body: text("body").notNull(),
    // A REAL foreign key, so a lesson cannot reference a document that never
    // existed. A document soft-deleted after being attached still resolves —
    // the read path sees `deleted_at` and renders the lesson without its
    // attachment rather than with a broken one.
    documentId: uuid("document_id").references(() => communityDocuments.id),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("course_lesson_section_position_idx").on(table.sectionId, table.position),
  ]
);

/**
 * Phase 8b. One direct-message thread between exactly two people.
 *
 * **THE PARTICIPANTS ARE STORED IN A CANONICAL ORDER**, lower uuid first, and
 * `conversation_ordered_pair` is what makes the unique index below mean
 * anything. Stored in whatever order the opener happened to be, the same pair
 * yields TWO rows depending on who spoke first — and neither participant
 * would see the other's messages, which is the worst failure this feature
 * has: it looks exactly like being ignored.
 *
 * Sorting by uuid is arbitrary but total, which is all a canonical form
 * needs.
 *
 * There is no `conversation_no_self` check: `x < x` is false, so the ordering
 * check already makes a self-conversation impossible to store.
 */
export const conversations = pgTable(
  "conversation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lowerUserId: uuid("lower_user_id")
      .notNull()
      .references(() => appUsers.id),
    higherUserId: uuid("higher_user_id")
      .notNull()
      .references(() => appUsers.id),
    // READ STATE, two columns rather than a table. The unread count is
    // "messages newer than my timestamp that I did not send"; a per-message
    // read table would be a row per message per reader for a feature whose
    // whole job is showing one number.
    //
    // NULL means never opened, which reads as "everything is unread" — which
    // is exactly right, and falls out rather than needing a special case.
    lowerLastReadAt: timestamp("lower_last_read_at", { withTimezone: true }),
    higherLastReadAt: timestamp("higher_last_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Exactly one conversation per pair — and it only holds because the pair
    // is canonically ordered by the CHECK below.
    uniqueIndex("conversation_pair_unique").on(table.lowerUserId, table.higherUserId),
    // "my conversations", from either side.
    index("conversation_lower_idx").on(table.lowerUserId),
    index("conversation_higher_idx").on(table.higherUserId),
    check(
      "conversation_ordered_pair",
      sql`${table.lowerUserId} < ${table.higherUserId}`
    ),
  ]
);

/**
 * Phase 8b. One message in a conversation.
 *
 * NO soft delete. A post or a comment has one because it is public and
 * removing it is moderation; a message is between two people and this phase
 * ships no way to delete one. The column would be something nothing writes,
 * whose meaning the first person to use it would decide.
 */
export const directMessages = pgTable(
  "direct_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => appUsers.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // OLDEST first, matching the comment thread and unlike the feed — a
    // conversation reads top to bottom. The same index serves the unread
    // count, which ranges on `created_at` within one conversation.
    index("direct_message_conversation_created_idx").on(
      table.conversationId,
      table.createdAt
    ),
  ]
);

/**
 * Phase 8a. One thing that happened TO somebody.
 *
 * Written AFTER the action that caused it has committed, and best-effort — a
 * failure to write one is logged, never thrown. The alternative, sharing the
 * action's transaction, makes a bug in notifications fail COMMENTING. Losing
 * a notification is undetectable; losing a comment is data loss. So a
 * notification can be lost, and nothing in the product depends on one having
 * arrived: the bell is a convenience over state already readable elsewhere.
 */
export const notifications = pgTable(
  "notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // THE RECIPIENT, not the actor. Named plainly because every read path
    // filters on it, and swapping the two would deliver every notification to
    // the person who caused it.
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id),
    // `comment` | `join` | `subscribe` | `follow`. VARCHAR, not an enum — the
    // reasoning `subscription.status` and `post.type` already record.
    kind: varchar("kind", { length: 32 }).notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => appUsers.id),
    // TWO nullable subject columns rather than one polymorphic id with a
    // type discriminator. Both are real foreign keys, so a notification
    // cannot point at a row that never existed; a single `subject_id` would
    // buy one column and lose that guarantee.
    //
    // NO STORED URL. The client builds the link from the kind and these ids —
    // storing an href is the mistake `MediaView` records about bucket URLs:
    // routes change, and the id is the identifier.
    postId: uuid("post_id").references(() => posts.id),
    communityId: uuid("community_id").references(() => communities.id),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The list.
    index("notification_user_created_idx").on(table.userId, table.createdAt.desc()),
    // The unread COUNT, which is the query that runs every sixty seconds for
    // every signed-in tab. PARTIAL, so read notifications leave it entirely —
    // and they are the overwhelming majority over time.
    index("notification_user_unread_idx")
      .on(table.userId, table.createdAt.desc())
      .where(sql`${table.readAt} is null`),
  ]
);

/**
 * Phase 4a. One file in a community's Dokumen library.
 *
 * `content_type` lives HERE rather than in bucket metadata, and that single
 * choice is what keeps `DocumentStoragePort` trivial — no variant, no content
 * type on write, no metadata read on delivery. The delivery route has to read
 * this row anyway (to check the community and the member gate), so the type
 * comes free with a lookup that was already happening.
 *
 * `uploader_id` is kept even though only an owner may upload today: owners can
 * change, so "who put this here" is not answerable from `community_id`
 * afterwards, and a future member-upload rule needs no migration.
 */
export const communityDocuments = pgTable(
  "community_document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communityId: uuid("community_id")
      .notNull()
      .references(() => communities.id),
    uploaderId: uuid("uploader_id")
      .notNull()
      .references(() => appUsers.id),
    // The original filename, SANITISED on the way in (see `domain/document.ts`):
    // never a path, never containing a control character. It is display text
    // and the download's suggested filename, and it is never part of a bucket
    // key — the key is the id alone.
    name: varchar("name", { length: 255 }).notNull(),
    // What the client declared, checked against the shared allowlist by the
    // write path. UNTRUSTED as a statement about the bytes — see the spec's
    // "The security decision" for the three measures that make that safe.
    contentType: varchar("content_type", { length: 128 }).notNull(),
    // Measured from the bytes actually received, never taken from the client.
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // SOFT delete, matching `post`. Every read path must filter it. Unlike a
    // post's images, the BYTES are removed from the bucket on delete: a
    // document has exactly one referent and no second surface that might
    // still want it.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Phase 5. `false` means any member may download it — Phase 4a's rule, and
    // what every row uploaded before this column keeps. `true` means an ACTIVE
    // SUBSCRIPTION TO THIS COMMUNITY is required, which is the one thing a
    // paid tier buys this phase.
    //
    // Per DOCUMENT and not per community: an owner marks the material worth
    // paying for and leaves the rest open, which is what keeps a community
    // with paid tiers still evaluable before joining.
    membersOnly: boolean("members_only").notNull().default(false),
  },
  (table) => [
    // The library listing. PARTIAL, so deleted rows leave the index entirely
    // rather than being filtered out of every scan — `post_live_created_idx`'s
    // shape and reasoning.
    index("community_document_community_created_idx")
      .on(table.communityId, table.createdAt.desc())
      .where(sql`${table.deletedAt} is null`),
  ]
);
