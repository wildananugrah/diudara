import { describe, expect, it } from "bun:test";
import { FakeStreamingAdapter } from "../../infrastructure/streaming/fake-streaming.adapter";
import { NotFoundError } from "../errors";
import type { EventRecord, EventRepositoryPort } from "../ports/event-repository.port";
import { ListLiveSessions, ScheduleLiveSession } from "./schedule-live-session";

let idCounter = 0;

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  idCounter += 1;
  return {
    id: `event-${idCounter}`,
    communityId: "community-1",
    title: "Live Q&A",
    scheduledAt: null,
    meetingLink: null,
    streamKey: null,
    status: "scheduled",
    hlsPlaybackPath: null,
    recordingUrl: null,
    ...overrides,
  };
}

/**
 * The SAME ownership model `DrizzleEventRepository` implements: creator-facing
 * methods return `null` for a community the given `ownerByCommunity` map does
 * not attribute to `creatorId`, indistinguishably from a community that does
 * not exist at all — so a use-case test against this fake exercises the exact
 * branch the real repository's scoping query would take.
 */
function fakeEventRepository(ownerByCommunity: Record<string, string>) {
  const rows: EventRecord[] = [];
  const repository: EventRepositoryPort = {
    async createForCreator(input) {
      if (ownerByCommunity[input.communityId] !== input.creatorId) return null;
      const row = event({
        communityId: input.communityId,
        title: input.title,
        scheduledAt: input.scheduledAt,
        streamKey: input.streamKey,
        hlsPlaybackPath: input.hlsPlaybackPath,
      });
      rows.push(row);
      return row;
    },
    async findByIdForCreator(id, communityId, creatorId) {
      if (ownerByCommunity[communityId] !== creatorId) return null;
      return rows.find((r) => r.id === id && r.communityId === communityId) ?? null;
    },
    async listForCommunityForCreator(communityId, creatorId) {
      if (ownerByCommunity[communityId] !== creatorId) return null;
      return rows.filter((r) => r.communityId === communityId);
    },
    async markLive(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.status = "live";
      return row;
    },
    async markEnded(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      row.status = "ended";
      return row;
    },
    async findByStreamKey(streamKey) {
      return rows.find((r) => r.streamKey === streamKey) ?? null;
    },
    async findLiveByCommunityId(communityId) {
      return rows.find((r) => r.communityId === communityId && r.status === "live") ?? null;
    },
    async findById(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
  };
  return { repository, rows };
}

describe("ScheduleLiveSession", () => {
  it("returns an RTMP URL and a stream key for a community the caller owns", async () => {
    const { repository } = fakeEventRepository({ "community-1": "creator-1" });
    const useCase = new ScheduleLiveSession(repository, new FakeStreamingAdapter());

    const result = await useCase.execute({
      creatorId: "creator-1",
      communityId: "community-1",
      title: "Live Q&A",
    });

    expect(result.rtmpUrl).toContain("rtmp://");
    expect(result.streamKey).toMatch(/^[0-9a-f]{32}$/);
    expect(result.hlsPlaybackPath).toContain(result.streamKey);
    expect(result.status).toBe("scheduled");
  });

  it("mints a DIFFERENT key for a second session in the same community", async () => {
    const { repository } = fakeEventRepository({ "community-1": "creator-1" });
    const useCase = new ScheduleLiveSession(repository, new FakeStreamingAdapter());

    const first = await useCase.execute({
      creatorId: "creator-1",
      communityId: "community-1",
      title: "Session one",
    });
    const second = await useCase.execute({
      creatorId: "creator-1",
      communityId: "community-1",
      title: "Session two",
    });

    expect(second.streamKey).not.toBe(first.streamKey);
    expect(second.rtmpUrl).not.toBe(first.rtmpUrl);
  });

  it("throws NotFoundError for another creator's community, and persists nothing", async () => {
    const { repository, rows } = fakeEventRepository({ "community-1": "creator-1" });
    const useCase = new ScheduleLiveSession(repository, new FakeStreamingAdapter());

    await expect(
      useCase.execute({
        creatorId: "stranger",
        communityId: "community-1",
        title: "Not yours",
      })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(rows).toHaveLength(0);
  });

  it("passes scheduledAt through when given, and null when omitted", async () => {
    const { repository, rows } = fakeEventRepository({ "community-1": "creator-1" });
    const useCase = new ScheduleLiveSession(repository, new FakeStreamingAdapter());
    const scheduledAt = new Date("2026-09-01T10:00:00.000Z");

    await useCase.execute({
      creatorId: "creator-1",
      communityId: "community-1",
      title: "With a time",
      scheduledAt,
    });
    await useCase.execute({
      creatorId: "creator-1",
      communityId: "community-1",
      title: "Without a time",
    });

    expect(rows[0]!.scheduledAt).toEqual(scheduledAt);
    expect(rows[1]!.scheduledAt).toBeNull();
  });
});

describe("ListLiveSessions", () => {
  it("lists sessions for a community the caller owns", async () => {
    const { repository } = fakeEventRepository({ "community-1": "creator-1" });
    const scheduler = new ScheduleLiveSession(repository, new FakeStreamingAdapter());
    await scheduler.execute({ creatorId: "creator-1", communityId: "community-1", title: "One" });

    const useCase = new ListLiveSessions(repository);
    const listed = await useCase.execute({ creatorId: "creator-1", communityId: "community-1" });

    expect(listed).toHaveLength(1);
    expect(listed[0]!.title).toBe("One");
  });

  it("throws NotFoundError for another creator's community", async () => {
    const { repository } = fakeEventRepository({ "community-1": "creator-1" });
    const useCase = new ListLiveSessions(repository);

    await expect(
      useCase.execute({ creatorId: "stranger", communityId: "community-1" })
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
