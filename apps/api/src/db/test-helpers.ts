import { db } from "./client";
import { isolationIsEnabled } from "./test-database";
import {
  webhookEvents,
  outbox,
  appUsers,
  passwordResetTokens,
  signupNotices,
  follows,
  postComments,
  postMedia,
  posts,
  userTiers,
  userSubscriptions,
  userTransactions,
  membershipReminders,
  userStreams,
  communities,
  communityMembers,
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
  await db.delete(outbox);
  // passwordResetTokens and signupNotices both reference app_user, so both
  // must clear before it — Task 5's additions, same FK-ordering rule as
  // every other table above.
  await db.delete(passwordResetTokens);
  await db.delete(signupNotices);
  // follow references app_user twice (follower and followee), so it must
  // clear before app_user too — Task 1 of profiles-and-following.
  await db.delete(follows);
  // postComments references app_user (author) and post, so it must clear
  // before both — Phase 2.
  await db.delete(postComments);
  // postMedia references app_user (owner) and post, so it must clear before
  // both — Task 1 of the images phase.
  await db.delete(postMedia);
  // post references app_user (author), so it must clear before app_user.
  await db.delete(posts);
  // userTransactions references userSubscriptions, which references both
  // app_user (subscriber, owner) and userTiers, so the clear order here is
  // userTransactions, then userSubscriptions, then userTiers, then app_user —
  // Task 2 of Phase 5a.
  await db.delete(userTransactions);
  // membershipReminders references userSubscriptions (Task 4 of Phase 5b), so it
  // must clear before it — the same FK-ordering rule every table above follows.
  await db.delete(membershipReminders);
  await db.delete(userSubscriptions);
  // userTiers references app_user (owner) — Task 1 of Phase 5a — so it must
  // clear before app_user too.
  await db.delete(userTiers);
  // userStreams references app_user (owner) — Task 1 of Phase 7 — so it too
  // must clear before app_user.
  await db.delete(userStreams);
  // communityMembers references community and app_user, so it must clear
  // before both — Phase 1, same FK-ordering rule as every entry above.
  await db.delete(communityMembers);
  // community references app_user (owner), so it must clear before app_user.
  await db.delete(communities);
  // app_user is a fully independent identity table (Phase 9's pivot) — no FK
  // relationship to anything above it, so its position here is free.
  await db.delete(appUsers);
}
