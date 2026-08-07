import { db } from "./client";
import {
  eventRsvps,
  events,
  enrollments,
  courses,
  activityLogs,
  transactions,
  subscriptions,
  channels,
  membershipTiers,
  communities,
  members,
  creators,
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
  await db.delete(eventRsvps);
  await db.delete(events);
  await db.delete(enrollments);
  await db.delete(courses);
  await db.delete(activityLogs);
  await db.delete(transactions);
  await db.delete(subscriptions);
  await db.delete(channels);
  await db.delete(membershipTiers);
  await db.delete(communities);
  await db.delete(members);
  await db.delete(creators);
}
