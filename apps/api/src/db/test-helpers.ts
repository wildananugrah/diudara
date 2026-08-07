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

export async function resetDatabase() {
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
