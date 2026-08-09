import { db } from "./client";
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
  membershipTiers,
  communities,
  members,
  creators,
  webhookEvents,
  outbox,
} from "./schema";

/**
 * Truncates every table. Destructive by design, and it runs against whatever
 * DATABASE_URL points at — so it refuses to run outside the test environment.
 * Spec 12 deploys this codebase to a VPS via Docker Compose, where a stray
 * `docker compose run api bun test` or a CI job holding production env would
 * otherwise wipe the live database. Bun sets NODE_ENV=test inside `bun test`.
 */
export function assertTestEnvironment() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `resetDatabase() refused: NODE_ENV is not 'test' (got ${
        process.env.NODE_ENV === undefined ? "undefined" : `'${process.env.NODE_ENV}'`
      })`,
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
  await db.delete(membershipTiers);
  await db.delete(communities);
  await db.delete(members);
  await db.delete(creators);
}
