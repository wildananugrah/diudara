import { describe, expect, it, beforeEach } from "bun:test";
import { db } from "../../db/client";
import { communities, creators } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleEventRepository } from "./drizzle-event.repository";

beforeEach(resetDatabase);

const repo = new DrizzleEventRepository(db);

let seedCounter = 0;

/** A creator with one community, which is what every test here starts from. */
async function seedCreatorWithCommunity(name = "Rina") {
  seedCounter += 1;
  const [creator] = await db.insert(creators).values({ name }).returning();
  const [community] = await db
    .insert(communities)
    .values({
      creatorId: creator.id,
      name: `Kelas ${name}`,
      slug: `kelas-${name.toLowerCase()}-${seedCounter}`,
    })
    .returning();
  return { creator, community };
}

function streamKey(label: string) {
  seedCounter += 1;
  return `${label}-${seedCounter}`;
}

describe("DrizzleEventRepository.createForCreator", () => {
  it("creates an event for a community the caller owns", async () => {
    const { creator, community } = await seedCreatorWithCommunity();

    const event = await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    expect(event).not.toBeNull();
    expect(event!.communityId).toBe(community.id);
    expect(event!.title).toBe("Live Q&A");
    expect(event!.status).toBe("scheduled");
  });

  it("returns null, and inserts nothing, for another creator's community", async () => {
    const owner = await seedCreatorWithCommunity("Rina");
    const stranger = await seedCreatorWithCommunity("Budi");

    const event = await repo.createForCreator({
      communityId: owner.community.id,
      creatorId: stranger.creator.id,
      title: "Not yours",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    expect(event).toBeNull();
    const listed = await repo.listForCommunityForCreator(owner.community.id, owner.creator.id);
    expect(listed).toEqual([]);
  });

  it("returns null for a community that does not exist", async () => {
    const { creator } = await seedCreatorWithCommunity();

    const event = await repo.createForCreator({
      communityId: "00000000-0000-4000-8000-000000000000",
      creatorId: creator.id,
      title: "Nowhere",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    expect(event).toBeNull();
  });
});

describe("DrizzleEventRepository.findByIdForCreator", () => {
  it("finds an event the caller owns", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const created = await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    const found = await repo.findByIdForCreator(created!.id, community.id, creator.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created!.id);
  });

  it("returns null for another creator's event", async () => {
    const owner = await seedCreatorWithCommunity("Rina");
    const stranger = await seedCreatorWithCommunity("Budi");
    const created = await repo.createForCreator({
      communityId: owner.community.id,
      creatorId: owner.creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    const found = await repo.findByIdForCreator(
      created!.id,
      owner.community.id,
      stranger.creator.id
    );
    expect(found).toBeNull();
  });
});

describe("DrizzleEventRepository.listForCommunityForCreator", () => {
  it("lists only this community's sessions, most recently scheduled first", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Earlier",
      scheduledAt: new Date("2026-09-01T10:00:00.000Z"),
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });
    await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Later",
      scheduledAt: new Date("2026-09-02T10:00:00.000Z"),
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    const listed = await repo.listForCommunityForCreator(community.id, creator.id);
    expect(listed).not.toBeNull();
    expect(listed!.map((e) => e.title)).toEqual(["Later", "Earlier"]);
  });

  it("returns null, not an empty list, for another creator's community", async () => {
    const owner = await seedCreatorWithCommunity("Rina");
    const stranger = await seedCreatorWithCommunity("Budi");
    await repo.createForCreator({
      communityId: owner.community.id,
      creatorId: owner.creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    const listed = await repo.listForCommunityForCreator(owner.community.id, stranger.creator.id);
    expect(listed).toBeNull();
  });

  it("never lists another creator's sessions alongside the caller's own", async () => {
    const mine = await seedCreatorWithCommunity("Rina");
    const theirs = await seedCreatorWithCommunity("Budi");
    await repo.createForCreator({
      communityId: mine.community.id,
      creatorId: mine.creator.id,
      title: "Mine",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });
    await repo.createForCreator({
      communityId: theirs.community.id,
      creatorId: theirs.creator.id,
      title: "Theirs",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    const listed = await repo.listForCommunityForCreator(mine.community.id, mine.creator.id);
    expect(listed).toHaveLength(1);
    expect(listed![0]!.title).toBe("Mine");
  });
});

describe("DrizzleEventRepository lifecycle transitions", () => {
  it("markLive sets status to live", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const created = await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    const live = await repo.markLive(created!.id);
    expect(live!.status).toBe("live");
  });

  it("markEnded sets status to ended", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const created = await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    const ended = await repo.markEnded(created!.id);
    expect(ended!.status).toBe("ended");
  });

  it("markLive returns null for an id that does not exist", async () => {
    expect(await repo.markLive("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("markLive returns null, and does not touch status, once the event is already live", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const created = await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });
    await repo.markLive(created!.id);

    const second = await repo.markLive(created!.id);

    expect(second).toBeNull();
  });

  it("markLive refuses to resurrect an ended event", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const created = await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });
    await repo.markEnded(created!.id);

    const late = await repo.markLive(created!.id);

    expect(late).toBeNull();
  });

  it("markEnded returns null once the event is already ended", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const created = await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });
    await repo.markEnded(created!.id);

    const second = await repo.markEnded(created!.id);

    expect(second).toBeNull();
  });

  it("markEnded transitions straight from scheduled — offline for a session that never went live", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const created = await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    const ended = await repo.markEnded(created!.id);

    expect(ended!.status).toBe("ended");
  });
});

describe("DrizzleEventRepository.findById", () => {
  it("resolves an event by id alone, with no creator in scope", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const created = await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: streamKey("key"),
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    const found = await repo.findById(created!.id);

    expect(found!.id).toBe(created!.id);
  });

  it("returns null for an id that does not exist", async () => {
    expect(await repo.findById("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("returns null rather than throwing for a value that cannot be a uuid", async () => {
    expect(await repo.findById("not-a-uuid")).toBeNull();
  });
});

describe("DrizzleEventRepository.findByStreamKey", () => {
  it("resolves an event by its stream key alone, with no creator in scope", async () => {
    const { creator, community } = await seedCreatorWithCommunity();
    const key = streamKey("resolve-me");
    const created = await repo.createForCreator({
      communityId: community.id,
      creatorId: creator.id,
      title: "Live Q&A",
      scheduledAt: null,
      streamKey: key,
      hlsPlaybackPath: "https://fake-mediamtx.local/hls/live/key/index.m3u8",
    });

    const found = await repo.findByStreamKey(key);
    expect(found!.id).toBe(created!.id);
  });

  it("returns null for an unknown stream key", async () => {
    expect(await repo.findByStreamKey("no-such-key")).toBeNull();
  });
});
