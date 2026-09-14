#!/usr/bin/env bun
/**
 * One-off script: adds fake members, a paid tier, and paid/failed
 * transactions to Wildan's own REAL community ("wildan-community", owned by
 * wildananugrah@gmail.com) — not a new sample community like
 * `seed-sample-data.ts` creates. Run from `apps/api`:
 *
 *   bun scripts/seed-wildan-community.ts
 *
 * Every row this owns is reachable from a `seed_wc_`-prefixed handle, so it
 * can be found and removed independently of `seed-sample-data.ts`'s own
 * `seed_*` rows (still matched by that script's broader `seed_%` cleanup
 * too, since the prefix nests inside it). Cleanup, children first:
 *
 *   DELETE FROM user_transaction WHERE user_subscription_id IN (SELECT id FROM user_subscription WHERE subscriber_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_wc_%'));
 *   DELETE FROM user_subscription WHERE subscriber_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_wc_%');
 *   DELETE FROM user_tier WHERE community_id = (SELECT id FROM community WHERE slug = 'wildan-community') AND name = 'Membership Bulanan';
 *   DELETE FROM community_member WHERE user_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_wc_%');
 *   DELETE FROM app_user WHERE handle LIKE 'seed_wc_%';
 *
 * Idempotent by handle: reruns skip any `seed_wc_` user that already exists,
 * so it won't double up members, subscriptions or transactions.
 */
import { and, eq } from "drizzle-orm";
import { db, sql as pg } from "../src/db/client";
import {
  appUsers,
  communities,
  communityMembers,
  userSubscriptions,
  userTiers,
  userTransactions,
} from "../src/db/schema";
import { BunPasswordHasher } from "../src/infrastructure/auth/bun-password.hasher";

const hasher = new BunPasswordHasher();
const SEED_PASSWORD = "SeedPass123!";
const OWNER_EMAIL = "wildananugrah@gmail.com";
const COMMUNITY_SLUG = "wildan-community";
const TIER_NAME = "Membership Bulanan";
const TIER_PRICE = 150_000;

type FakeMember = {
  handle: string;
  displayName: string;
  bio: string;
  joinedAt: string;
  /** `null` = joined free, no paid membership at all. */
  subscription: {
    status: "active" | "expired";
    /** ISO date the tier was first paid for. */
    paidAt: string;
    /** Set on top of the paid transaction — an earlier failed attempt. */
    failedAttemptAt?: string;
  } | null;
};

const MEMBERS: FakeMember[] = [
  {
    handle: "seed_wc_andi",
    displayName: "Andi Kurniawan",
    bio: "Suka belajar hal baru bareng komunitas.",
    joinedAt: "2026-04-10T05:00:00.000Z",
    subscription: { status: "active", paidAt: "2026-04-10T05:00:00.000Z" },
  },
  {
    handle: "seed_wc_siti",
    displayName: "Siti Rahma",
    bio: "Aktif ikut diskusi mingguan.",
    joinedAt: "2026-05-12T05:00:00.000Z",
    subscription: { status: "active", paidAt: "2026-05-12T05:00:00.000Z" },
  },
  {
    handle: "seed_wc_bagus",
    displayName: "Bagus Prasetyo",
    bio: "Baru gabung, semangat belajar.",
    joinedAt: "2026-06-14T05:00:00.000Z",
    subscription: {
      status: "active",
      paidAt: "2026-06-14T05:00:00.000Z",
      failedAttemptAt: "2026-06-10T05:00:00.000Z",
    },
  },
  {
    handle: "seed_wc_nadia",
    displayName: "Nadia Putri",
    bio: "Freelancer, ikut komunitas buat upskilling.",
    joinedAt: "2026-07-11T05:00:00.000Z",
    subscription: { status: "active", paidAt: "2026-07-11T05:00:00.000Z" },
  },
  {
    handle: "seed_wc_rangga",
    displayName: "Rangga Saputra",
    bio: "Sempat aktif, sekarang jarang mampir.",
    joinedAt: "2026-07-20T05:00:00.000Z",
    subscription: { status: "expired", paidAt: "2026-07-20T05:00:00.000Z" },
  },
  {
    handle: "seed_wc_yusuf",
    displayName: "Yusuf Firmansyah",
    bio: "Mahasiswa, aktif ikut kelas online.",
    joinedAt: "2026-08-09T05:00:00.000Z",
    subscription: {
      status: "active",
      paidAt: "2026-08-09T05:00:00.000Z",
      failedAttemptAt: "2026-08-05T05:00:00.000Z",
    },
  },
  {
    handle: "seed_wc_melati",
    displayName: "Melati Wulandari",
    bio: "Ikut sebentar, membershipnya sudah berakhir.",
    joinedAt: "2026-08-22T05:00:00.000Z",
    subscription: { status: "expired", paidAt: "2026-08-22T05:00:00.000Z" },
  },
  {
    handle: "seed_wc_dewi",
    displayName: "Dewi Anjani",
    bio: "Member baru bulan ini.",
    joinedAt: "2026-09-05T05:00:00.000Z",
    subscription: { status: "active", paidAt: "2026-09-05T05:00:00.000Z" },
  },
  {
    handle: "seed_wc_fajar",
    displayName: "Fajar Hidayat",
    bio: "Baru gabung, masih lihat-lihat dulu.",
    joinedAt: "2026-09-03T05:00:00.000Z",
    subscription: null,
  },
  {
    handle: "seed_wc_citra",
    displayName: "Citra Ayu",
    bio: "Gabung gratis, siapa tau nanti upgrade.",
    joinedAt: "2026-09-08T05:00:00.000Z",
    subscription: null,
  },
];

/** Any active-status subscription reads as current membership until this. */
function activePeriodEnd(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return d;
}

/** Any expired-status subscription reads as lapsed since this. */
function expiredPeriodEnd(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 10);
  return d;
}

async function ensureFakeUser(m: FakeMember): Promise<{ id: string; created: boolean }> {
  const existing = await db.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.handle, m.handle));
  if (existing.length > 0) return { id: existing[0]!.id, created: false };

  const passwordHash = await hasher.hash(SEED_PASSWORD);
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: m.handle,
      // example.com is IANA-reserved for documentation (RFC 2606) — cannot
      // deliver to anyone, by design.
      email: `${m.handle}@example.com`,
      whatsappNumber: null,
      passwordHash,
      displayName: m.displayName,
      bio: m.bio,
    })
    .returning({ id: appUsers.id });
  return { id: row!.id, created: true };
}

async function main() {
  console.log(`==> seeding into ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":****@")}`);

  const [owner] = await db.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.email, OWNER_EMAIL));
  if (!owner) throw new Error(`no user with email ${OWNER_EMAIL}`);

  const [community] = await db
    .select({ id: communities.id, ownerId: communities.ownerId })
    .from(communities)
    .where(eq(communities.slug, COMMUNITY_SLUG));
  if (!community) throw new Error(`no community with slug ${COMMUNITY_SLUG}`);
  if (community.ownerId !== owner.id) {
    throw new Error(`${COMMUNITY_SLUG} is not owned by ${OWNER_EMAIL}`);
  }

  let [tier] = await db
    .select({ id: userTiers.id })
    .from(userTiers)
    .where(and(eq(userTiers.communityId, community.id), eq(userTiers.name, TIER_NAME)));
  if (!tier) {
    const [row] = await db
      .insert(userTiers)
      .values({
        ownerId: owner.id,
        communityId: community.id,
        name: TIER_NAME,
        priceAmount: TIER_PRICE,
        billingCycle: "monthly",
        isActive: true,
      })
      .returning({ id: userTiers.id });
    tier = row!;
    console.log(`==> tier "${TIER_NAME}" created (Rp ${TIER_PRICE.toLocaleString("id-ID")}/bulan)`);
  } else {
    console.log(`==> tier "${TIER_NAME}" already exists`);
  }

  let membersAdded = 0;
  let subscriptionsAdded = 0;
  let transactionsAdded = 0;

  for (const m of MEMBERS) {
    const { id: userId, created } = await ensureFakeUser(m);
    if (!created) {
      console.log(`   skip ${m.handle} — already seeded`);
      continue;
    }
    membersAdded++;

    await db
      .insert(communityMembers)
      .values({ communityId: community.id, userId, role: "member", joinedAt: new Date(m.joinedAt) })
      .onConflictDoNothing();

    if (m.subscription !== null) {
      const periodEnd = m.subscription.status === "active" ? activePeriodEnd() : expiredPeriodEnd();
      const [sub] = await db
        .insert(userSubscriptions)
        .values({
          subscriberId: userId,
          tierId: tier.id,
          ownerId: owner.id,
          status: m.subscription.status,
          kind: "paid",
          communityId: community.id,
          currentPeriodEnd: periodEnd,
          createdAt: new Date(m.subscription.paidAt),
        })
        .returning({ id: userSubscriptions.id });
      subscriptionsAdded++;

      if (m.subscription.failedAttemptAt) {
        await db.insert(userTransactions).values({
          userSubscriptionId: sub!.id,
          amount: TIER_PRICE,
          status: "expired",
          paidAt: null,
          createdAt: new Date(m.subscription.failedAttemptAt),
        });
        transactionsAdded++;
      }

      await db.insert(userTransactions).values({
        userSubscriptionId: sub!.id,
        amount: TIER_PRICE,
        status: "paid",
        paidAt: new Date(m.subscription.paidAt),
        createdAt: new Date(m.subscription.paidAt),
      });
      transactionsAdded++;
    }
  }

  console.log(
    `==> done: ${membersAdded} members, ${subscriptionsAdded} subscriptions, ${transactionsAdded} transactions added`
  );
  console.log("==> sign in as any seed_wc_* handle with password: " + SEED_PASSWORD);
  await pg.end();
}

main().catch(async (err) => {
  console.error(err);
  await pg.end();
  process.exit(1);
});
