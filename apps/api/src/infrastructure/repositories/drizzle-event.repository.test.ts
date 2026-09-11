import { describe, expect, test, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { appUsers, communities, communityEvents, posts } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleEventRepository } from "./drizzle-event.repository";

let counter = 0;

async function seedCommunity() {
  counter += 1;
  const [user] = await db
    .insert(appUsers)
    .values({
      handle: `host${counter}`,
      email: `host${counter}@example.com`,
      passwordHash: "irrelevant-hash",
      displayName: `Host ${counter}`,
    })
    .returning();
  const [community] = await db
    .insert(communities)
    .values({
      ownerId: user!.id,
      name: `Kelas ${counter}`,
      slug: `kelas-${counter}`,
      category: "Bimbel & Ujian",
    })
    .returning();
  return { user: user!, communityId: community!.id };
}

async function seedEvent(
  ownerId: string,
  communityId: string,
  title: string,
  startsAt: Date,
  extra: { endsAt?: Date; location?: string } = {}
) {
  const [post] = await db
    .insert(posts)
    .values({ authorId: ownerId, communityId, body: `deskripsi ${title}`, type: "kegiatan" })
    .returning();
  await db.insert(communityEvents).values({
    postId: post!.id,
    communityId,
    title,
    startsAt,
    ...extra,
  });
  return post!.id;
}

/** The September 2026 WIB month, as UTC instants. */
const SEPTEMBER_FROM = new Date("2026-08-31T17:00:00.000Z");
const SEPTEMBER_TO = new Date("2026-09-30T17:00:00.000Z");

describe("DrizzleEventRepository.listBetween", () => {
  beforeEach(resetDatabase);

  test("returns one community's events in the range, ascending, with the author joined", async () => {
    const { user, communityId } = await seedCommunity();
    await seedEvent(user.id, communityId, "Kedua", new Date("2026-09-20T13:00:00.000Z"));
    await seedEvent(user.id, communityId, "Pertama", new Date("2026-09-15T09:00:00.000Z"), {
      endsAt: new Date("2026-09-15T11:00:00.000Z"),
      location: "Online via Zoom",
    });

    const rows = await new DrizzleEventRepository(db).listBetween(
      communityId,
      SEPTEMBER_FROM,
      SEPTEMBER_TO
    );

    // Ascending is the agenda's order, so the repository owes it — a caller
    // that re-sorts is a caller that can forget to.
    expect(rows.map((row) => row.title)).toEqual(["Pertama", "Kedua"]);
    expect(rows[0]!.endsAt).toEqual(new Date("2026-09-15T11:00:00.000Z"));
    expect(rows[0]!.location).toBe("Online via Zoom");
    expect(rows[0]!.authorHandle).toBe(user.handle);
    expect(rows[1]!.endsAt).toBeNull();
    expect(rows[1]!.location).toBeNull();
  });

  test("another community's events are not in it", async () => {
    const mine = await seedCommunity();
    const theirs = await seedCommunity();
    await seedEvent(mine.user.id, mine.communityId, "Punya saya", new Date("2026-09-15T09:00:00.000Z"));
    await seedEvent(theirs.user.id, theirs.communityId, "Punya mereka", new Date("2026-09-16T09:00:00.000Z"));

    const rows = await new DrizzleEventRepository(db).listBetween(
      mine.communityId,
      SEPTEMBER_FROM,
      SEPTEMBER_TO
    );

    expect(rows.map((row) => row.title)).toEqual(["Punya saya"]);
  });

  /**
   * The half-open range, asserted at both ends in one test so neither bound
   * can be loosened without the other's case going red.
   */
  test("the range includes its start instant and excludes its end instant", async () => {
    const { user, communityId } = await seedCommunity();
    // 1 September 2026, 00:00 WIB exactly — the first instant of the month.
    await seedEvent(user.id, communityId, "Tepat awal", SEPTEMBER_FROM);
    // 1 October 2026, 00:00 WIB exactly — the first instant of the NEXT month.
    await seedEvent(user.id, communityId, "Tepat akhir", SEPTEMBER_TO);
    // 31 August 2026, 23:59 WIB — the last instant of the month before.
    await seedEvent(user.id, communityId, "Sebelum", new Date("2026-08-31T16:59:00.000Z"));

    const rows = await new DrizzleEventRepository(db).listBetween(
      communityId,
      SEPTEMBER_FROM,
      SEPTEMBER_TO
    );

    expect(rows.map((row) => row.title)).toEqual(["Tepat awal"]);
  });

  test("an event whose post is soft-deleted drops out — the post is the lifecycle", async () => {
    const { user, communityId } = await seedCommunity();
    const postId = await seedEvent(user.id, communityId, "Dibatalkan", new Date("2026-09-15T09:00:00.000Z"));
    await seedEvent(user.id, communityId, "Tetap ada", new Date("2026-09-16T09:00:00.000Z"));
    await db.update(posts).set({ deletedAt: new Date() }).where(eq(posts.id, postId));

    const rows = await new DrizzleEventRepository(db).listBetween(
      communityId,
      SEPTEMBER_FROM,
      SEPTEMBER_TO
    );

    expect(rows.map((row) => row.title)).toEqual(["Tetap ada"]);
  });
});
