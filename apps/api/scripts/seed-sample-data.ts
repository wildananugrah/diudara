#!/usr/bin/env bun
/**
 * One-off script: seeds clearly-marked sample data — members, communities,
 * posts, comments, tiers, one live stream, kegiatan events and a syllabus —
 * directly into whatever `DATABASE_URL` this process resolves to. Run from
 * `apps/api` (`bun scripts/seed-sample-data.ts`), that is this box's
 * production database right now: there is no separate staging DB configured
 * (see `apps/api/.env`).
 *
 * NOT wired through the app's use-cases, deliberately: plain schema-valid
 * inserts only, so nothing here can trigger a real email/WhatsApp send, an
 * in-app notification storm, or a payment-provider call. The one thing this
 * script does NOT attempt is actually charging for a paid tier — it only
 * writes the `user_tier` row a price renders from; nobody's card is charged
 * to seed a price tag.
 *
 * Every row this script owns is reachable from a `seed_`-prefixed handle —
 * see `USERS` below — which is what makes it possible to find and remove
 * everything again. Cleanup (children first, no cascades configured):
 *
 *   DELETE FROM stream_viewer_heartbeat WHERE stream_id IN (SELECT id FROM user_stream WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%'));
 *   DELETE FROM user_stream WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%');
 *   DELETE FROM course_lesson WHERE section_id IN (SELECT id FROM course_section WHERE community_id IN (SELECT id FROM community WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%')));
 *   DELETE FROM course_section WHERE community_id IN (SELECT id FROM community WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%'));
 *   DELETE FROM community_event WHERE community_id IN (SELECT id FROM community WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%'));
 *   DELETE FROM post_comment WHERE author_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%') OR post_id IN (SELECT id FROM post WHERE community_id IN (SELECT id FROM community WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%')));
 *   DELETE FROM post WHERE author_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%') OR community_id IN (SELECT id FROM community WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%'));
 *   DELETE FROM user_tier WHERE community_id IN (SELECT id FROM community WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%'));
 *   DELETE FROM community_member WHERE community_id IN (SELECT id FROM community WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%'));
 *   DELETE FROM community WHERE owner_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%');
 *   DELETE FROM follow WHERE follower_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%') OR followee_id IN (SELECT id FROM app_user WHERE handle LIKE 'seed_%');
 *   DELETE FROM app_user WHERE handle LIKE 'seed_%';
 *
 * Idempotent by anchor: a user is looked up by handle before insert, a
 * community by slug. Rerunning skips anything that already exists rather
 * than duplicating it — downstream rows (posts, tiers, members, events,
 * syllabus) are only written the FIRST time a community is created.
 */
import { and, eq } from "drizzle-orm";
import { db, sql as pg } from "../src/db/client";
import {
  appUsers,
  communities,
  communityEvents,
  communityMembers,
  courseLessons,
  courseSections,
  follows,
  postComments,
  posts,
  streamViewerHeartbeats,
  userStreams,
  userTiers,
} from "../src/db/schema";
import { BunPasswordHasher } from "../src/infrastructure/auth/bun-password.hasher";

const hasher = new BunPasswordHasher();
/** The same password for every seed account, so you can sign in as any of them. */
const SEED_PASSWORD = "SeedPass123!";

type SeedUser = {
  handle: string;
  displayName: string;
  bio: string;
};

const USERS: SeedUser[] = [
  { handle: "seed_dinda", displayName: "Dinda Prameswari", bio: "Desainer UI/UX, ngajarin desain dari nol." },
  { handle: "seed_bayu", displayName: "Bayu Saputra", bio: "Tutor matematika, fokus persiapan SNBT." },
  { handle: "seed_intan", displayName: "Intan Kusuma", bio: "Suka ngaji bareng dan diskusi tafsir." },
  { handle: "seed_farhan", displayName: "Farhan Ramadhan", bio: "Belajar saham & investasi bareng-bareng." },
  { handle: "seed_ayu", displayName: "Ayu Lestari", bio: "Freelancer, lagi belajar banyak hal baru." },
  { handle: "seed_rio", displayName: "Rio Pratama", bio: "Mahasiswa, aktif ikut kelas online." },
  { handle: "seed_maya", displayName: "Maya Anggraini", bio: "Ibu rumah tangga yang lagi upskilling." },
  { handle: "seed_dimas", displayName: "Dimas Setiawan", bio: "Kerja kantoran, belajar di waktu luang." },
];

async function ensureUser(u: SeedUser): Promise<string> {
  const existing = await db.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.handle, u.handle));
  if (existing.length > 0) return existing[0]!.id;

  const passwordHash = await hasher.hash(SEED_PASSWORD);
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: u.handle,
      // example.com is IANA-reserved for documentation (RFC 2606) — these
      // addresses cannot deliver to anyone, by design.
      email: `${u.handle}@example.com`,
      whatsappNumber: null,
      passwordHash,
      displayName: u.displayName,
      bio: u.bio,
    })
    .returning({ id: appUsers.id });
  return row!.id;
}

type SeedCommunity = {
  slug: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  ownerHandle: string;
  memberHandles: string[];
  /** `null` = no active tier at all (plain "Gabung"). */
  tier: { name: string; priceAmount: number } | null;
};

const COMMUNITIES: SeedCommunity[] = [
  {
    slug: "kelas-desain-ui-ux",
    name: "Kelas Desain UI/UX",
    category: "Skill Digital",
    description: "Belajar desain UI/UX dari dasar sampai siap kerja, bareng-bareng.",
    tags: ["desain", "ui-ux", "figma"],
    ownerHandle: "seed_dinda",
    memberHandles: ["seed_ayu", "seed_rio", "seed_bayu"],
    tier: { name: "Membership Bulanan", priceAmount: 149000 },
  },
  {
    slug: "bimbel-matematika-snbt",
    name: "Bimbel Matematika SNBT",
    category: "Bimbel & Ujian",
    description: "Persiapan SNBT bareng, latihan soal dan try out rutin.",
    tags: ["snbt", "matematika", "try-out"],
    ownerHandle: "seed_bayu",
    memberHandles: ["seed_dinda", "seed_maya"],
    tier: { name: "Akses Gratis", priceAmount: 0 },
  },
  {
    slug: "kajian-rutin-ahad",
    name: "Kajian Rutin Ahad",
    category: "Kajian & Rohani",
    description: "Kajian tafsir dan diskusi keislaman setiap Ahad.",
    tags: ["kajian", "tafsir"],
    ownerHandle: "seed_intan",
    memberHandles: ["seed_farhan", "seed_dimas"],
    tier: null,
  },
  {
    slug: "trading-investasi-pemula",
    name: "Trading & Investasi Pemula",
    category: "Edukasi Finansial",
    description: "Belajar saham dan investasi dari nol, cocok untuk pemula.",
    tags: ["saham", "investasi", "pemula"],
    ownerHandle: "seed_farhan",
    memberHandles: ["seed_intan", "seed_ayu", "seed_maya", "seed_rio", "seed_dimas"],
    tier: { name: "Membership Premium", priceAmount: 75000 },
  },
];

async function ensureCommunity(
  c: SeedCommunity,
  userId: Map<string, string>
): Promise<{ id: string; created: boolean }> {
  const existing = await db.select({ id: communities.id }).from(communities).where(eq(communities.slug, c.slug));
  if (existing.length > 0) return { id: existing[0]!.id, created: false };

  const ownerId = userId.get(c.ownerHandle)!;
  const [row] = await db
    .insert(communities)
    .values({
      ownerId,
      name: c.name,
      slug: c.slug,
      category: c.category,
      description: c.description,
      tags: c.tags,
    })
    .returning({ id: communities.id });
  const communityId = row!.id;

  await db.insert(communityMembers).values([
    { communityId, userId: ownerId, role: "owner" },
    ...c.memberHandles.map((handle) => ({ communityId, userId: userId.get(handle)!, role: "member" })),
  ]);

  if (c.tier !== null) {
    await db.insert(userTiers).values({
      ownerId,
      communityId,
      name: c.tier.name,
      priceAmount: c.tier.priceAmount,
      billingCycle: "monthly",
      isActive: true,
    });
  }

  return { id: communityId, created: true };
}

async function seedCommunityContent(
  community: SeedCommunity,
  communityId: string,
  userId: Map<string, string>
) {
  const ownerId = userId.get(community.ownerHandle)!;
  const memberIds = community.memberHandles.map((h) => userId.get(h)!);
  const authors = [ownerId, ...memberIds];

  // Diskusi + pengumuman, a handful each, with a couple of comments so the
  // feed and the Diskusi tab don't render empty.
  const diskusiBodies = [
    "Halo semua! Ada yang mau share progress minggu ini?",
    "Ada rekomendasi sumber belajar tambahan nggak, guys?",
  ];
  const pengumumanBodies = ["Pengumuman: jadwal sesi live minggu ini disesuaikan, cek Kegiatan ya."];

  for (const body of diskusiBodies) {
    const [post] = await db
      .insert(posts)
      .values({ authorId: ownerId, body, communityId, visibility: "public", type: "diskusi" })
      .returning({ id: posts.id });
    await db.insert(postComments).values(
      authors.slice(0, 2).map((authorId) => ({
        postId: post!.id,
        authorId,
        body: "Setuju, makasih sudah berbagi!",
      }))
    );
  }
  for (const body of pengumumanBodies) {
    await db.insert(posts).values({ authorId: ownerId, body, communityId, visibility: "public", type: "pengumuman" });
  }

  // Kegiatan — one in the current WIB month, one in the next, so the
  // CommunitySidebar's two-month read has something in both.
  const eventPlans: Array<{ title: string; startsAt: string; location: string | null }> = [
    { title: `Sesi Live: ${community.name}`, startsAt: nextEventDate(6, 10), location: null },
    { title: `Workshop Lanjutan: ${community.name}`, startsAt: nextEventDate(28, 14), location: "Zoom" },
  ];
  for (const plan of eventPlans) {
    const [post] = await db
      .insert(posts)
      .values({
        authorId: ownerId,
        body: `Yuk ikutan "${plan.title}" — detail dan link akan dibagikan di grup.`,
        communityId,
        visibility: "public",
        type: "kegiatan",
      })
      .returning({ id: posts.id });
    await db.insert(communityEvents).values({
      postId: post!.id,
      communityId,
      title: plan.title,
      startsAt: new Date(plan.startsAt),
      location: plan.location,
    });
  }

  // A short two-section syllabus for the Materi tab.
  const sectionTitles = ["Minggu 1: Dasar-dasar", "Minggu 2: Praktik"];
  for (let i = 0; i < sectionTitles.length; i++) {
    const [section] = await db
      .insert(courseSections)
      .values({ communityId, title: sectionTitles[i]!, position: i })
      .returning({ id: courseSections.id });
    await db.insert(courseLessons).values([
      { sectionId: section!.id, title: "Pengantar", body: "Materi pengantar untuk sesi ini.", position: 0 },
      { sectionId: section!.id, title: "Latihan", body: "Latihan mandiri untuk sesi ini.", position: 1 },
    ]);
  }
}

/** A UTC instant `daysAhead` days from now, at `wibHour`:00 WIB. Approximate — fine for sample data. */
function nextEventDate(daysAhead: number, wibHour: number): string {
  const at = new Date();
  at.setUTCDate(at.getUTCDate() + daysAhead);
  at.setUTCHours(wibHour - 7, 0, 0, 0);
  return at.toISOString();
}

async function seedFollows(userId: Map<string, string>) {
  const pairs: Array<[string, string]> = [
    ["seed_ayu", "seed_dinda"],
    ["seed_rio", "seed_bayu"],
    ["seed_maya", "seed_farhan"],
    ["seed_dimas", "seed_intan"],
    ["seed_dinda", "seed_farhan"],
  ];
  for (const [followerHandle, followeeHandle] of pairs) {
    await db
      .insert(follows)
      .values({ followerId: userId.get(followerHandle)!, followeeId: userId.get(followeeHandle)! })
      .onConflictDoNothing();
  }
}

/**
 * One seed owner goes "live" — the community banner's LIVE badge and
 * `/siaran` both read this. It is NOT wired to any real MediaMTX stream: the
 * player on `/siaran/:id` will fail to load video, which is expected. The
 * viewer count is also short-lived by design — `GET /streams` only counts
 * heartbeats from the last 20 seconds (`VIEWER_HEARTBEAT_WINDOW_MS`), a real
 * "still watching" signal nginx records on every HLS request — so the count
 * this script seeds will read 0 again within moments of the run finishing.
 */
async function seedLiveStream(userId: Map<string, string>) {
  const ownerId = userId.get("seed_dinda")!;
  const alreadyLive = await db
    .select({ id: userStreams.id })
    .from(userStreams)
    .where(and(eq(userStreams.ownerId, ownerId), eq(userStreams.status, "live")));
  if (alreadyLive.length > 0) return;

  const [stream] = await db
    .insert(userStreams)
    .values({
      ownerId,
      title: "Sesi Live: Kelas Desain UI/UX",
      visibility: "public",
      streamKey: `seed-${crypto.randomUUID()}`,
      status: "live",
    })
    .returning({ id: userStreams.id });

  await db.insert(streamViewerHeartbeats).values(
    Array.from({ length: 7 }, (_, i) => ({
      streamId: stream!.id,
      identity: `seed-viewer-${i}-${crypto.randomUUID()}`,
    }))
  );
}

async function main() {
  console.log(`==> seeding sample data into ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":****@")}`);

  const userId = new Map<string, string>();
  for (const u of USERS) {
    userId.set(u.handle, await ensureUser(u));
  }
  console.log(`==> ${USERS.length} users ready`);

  let createdCommunities = 0;
  for (const c of COMMUNITIES) {
    const { id, created } = await ensureCommunity(c, userId);
    if (created) {
      await seedCommunityContent(c, id, userId);
      createdCommunities++;
    }
  }
  console.log(`==> ${COMMUNITIES.length} communities ready (${createdCommunities} newly created)`);

  await seedFollows(userId);
  console.log("==> follows ready");

  await seedLiveStream(userId);
  console.log("==> live stream ready (fake — no real video)");

  console.log("==> done. Sign in as any seed_* handle with password: " + SEED_PASSWORD);
  await pg.end();
}

main().catch(async (err) => {
  console.error(err);
  await pg.end();
  process.exit(1);
});
