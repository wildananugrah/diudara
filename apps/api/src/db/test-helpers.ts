import { db } from "./client";
import { isolationIsEnabled } from "./test-database";
import {
  eventRsvps,
  events,
  enrollments,
  courses,
  activityLogs,
  transactions,
  renewalReminders,
  subscriptions,
  channelMemberships,
  channels,
  joinRequests,
  membershipTiers,
  communities,
  members,
  creators,
  webhookEvents,
  outbox,
  aiMessages,
  aiConversations,
  aiUsage,
} from "./schema";

/**
 * Truncates every table. Destructive by design, and it runs against whatever
 * DATABASE_URL points at — so it refuses to run outside the test environment.
 * Spec 12 deploys this codebase to a VPS via Docker Compose, where a stray
 * `docker compose run api bun test` or a CI job holding production env would
 * otherwise wipe the live database. Bun sets NODE_ENV=test inside `bun test`.
 *
 * SECOND GUARD, added with per-run test databases (Task 8): NODE_ENV=test is not
 * enough, because a `bun test` that somehow ran without the preload has
 * NODE_ENV=test and a DATABASE_URL pointing at the DEVELOPMENT database, and this
 * function would truncate it. That is not hypothetical — it is what every test run
 * did before Task 8, and `drizzle/README.md` records the migration failure it caused.
 * The preload publishes the name of the database it created; without that name, an
 * un-isolated run now says so instead of quietly wiping somebody's local data.
 */
export function assertTestEnvironment() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `resetDatabase() refused: NODE_ENV is not 'test' (got ${
        process.env.NODE_ENV === undefined ? "undefined" : `'${process.env.NODE_ENV}'`
      })`,
    );
  }

  if (isolationIsEnabled(process.env) && !process.env.DIUDARA_TEST_DATABASE) {
    throw new Error(
      "resetDatabase() refused: this run has no database of its own, so truncating " +
        "would destroy whatever DATABASE_URL points at (usually your development " +
        "database). The test preload creates one — check that `bunfig.toml` in the " +
        "directory you ran from has `[test] preload = [\"…/test-env-preload.ts\"]`. " +
        "To run against DATABASE_URL on purpose, set DIUDARA_TEST_DB_ISOLATION=off.",
    );
  }
}

export async function resetDatabase() {
  assertTestEnvironment();
  await db.delete(webhookEvents);
  await db.delete(eventRsvps);
  await db.delete(events);
  await db.delete(enrollments);
  await db.delete(courses);
  await db.delete(activityLogs);
  await db.delete(transactions);
  // renewalReminders references subscriptions, so it must be cleared first — a
  // single leftover reminder would otherwise make every later test file fail on an
  // FK violation here rather than on anything it asserts.
  await db.delete(renewalReminders);
  await db.delete(subscriptions);
  // channelMemberships references members and channels, so it must be
  // cleared before either. outbox has no FKs, so its position is free.
  await db.delete(channelMemberships);
  await db.delete(outbox);
  await db.delete(channels);
  // joinRequests references community, membership_tier, member and creator, so it
  // must clear before all four.
  await db.delete(joinRequests);
  await db.delete(membershipTiers);
  await db.delete(communities);
  await db.delete(members);
  // aiMessages references aiConversations, and both reference creators, so
  // both must clear before creators — aiMessages first, per FK order.
  await db.delete(aiMessages);
  await db.delete(aiConversations);
  await db.delete(aiUsage);
  await db.delete(creators);
}
