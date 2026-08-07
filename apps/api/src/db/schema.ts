import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
} from "drizzle-orm/pg-core";

export const creators = pgTable("creator", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  whatsappNumber: varchar("whatsapp_number", { length: 32 }).notNull(),
  email: varchar("email", { length: 255 }),
  tierPlan: varchar("tier_plan", { length: 32 }).notNull().default("starter"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const communities = pgTable("community", {
  id: uuid("id").primaryKey().defaultRandom(),
  creatorId: uuid("creator_id").notNull().references(() => creators.id),
  name: varchar("name", { length: 255 }).notNull(),
  niche: varchar("niche", { length: 128 }),
  status: varchar("status", { length: 32 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const membershipTiers = pgTable("membership_tier", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id").notNull().references(() => communities.id),
  name: varchar("name", { length: 128 }).notNull(),
  priceAmount: integer("price_amount").notNull(),
  billingCycle: varchar("billing_cycle", { length: 16 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

export const channels = pgTable("channel", {
  id: uuid("id").primaryKey().defaultRandom(),
  communityId: uuid("community_id").notNull().references(() => communities.id),
  platform: varchar("platform", { length: 16 }).notNull(),
  externalGroupId: varchar("external_group_id", { length: 255 }),
  inviteLink: varchar("invite_link", { length: 512 }),
  botStatus: varchar("bot_status", { length: 32 }).notNull().default("disconnected"),
});

export const members = pgTable("member", {
  id: uuid("id").primaryKey().defaultRandom(),
  whatsappNumber: varchar("whatsapp_number", { length: 32 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable("subscription", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").notNull().references(() => members.id),
  tierId: uuid("tier_id").notNull().references(() => membershipTiers.id),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  nextBillingDate: date("next_billing_date"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  retryCount: integer("retry_count").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
});

export const transactions = pgTable("transaction", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscriptions.id),
  amount: integer("amount").notNull(),
  paymentMethod: varchar("payment_method", { length: 16 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  gatewayReferenceId: varchar("gateway_reference_id", { length: 255 }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
});

export const activityLogs = pgTable("activity_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id").references(() => members.id),
  communityId: uuid("community_id").notNull().references(() => communities.id),
  eventType: varchar("event_type", { length: 32 }).notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
