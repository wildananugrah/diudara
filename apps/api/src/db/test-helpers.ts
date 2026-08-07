import { db } from "./client";
import {
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
  await db.delete(activityLogs);
  await db.delete(transactions);
  await db.delete(subscriptions);
  await db.delete(channels);
  await db.delete(membershipTiers);
  await db.delete(communities);
  await db.delete(members);
  await db.delete(creators);
}
