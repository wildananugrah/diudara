import { describe, expect, test } from "bun:test";
import { NotFoundError } from "../errors";
import type { ClockPort } from "../ports/clock.port";
import type { CommunityRecord, CommunityRepositoryPort } from "../ports/community-repository.port";
import type { EventRepositoryPort, EventRow } from "../ports/event-repository.port";
import { ListCommunityEvents } from "./community-events";

const COMMUNITY_ID = "11111111-0000-4000-8000-000000000000";

function community(): CommunityRecord {
  return {
    id: COMMUNITY_ID,
    ownerId: "22222222-0000-4000-8000-000000000000",
    name: "Kelas Fisika",
    slug: "kelas-fisika",
    category: "Bimbel & Ujian",
    description: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    tags: [],
  };
}

/**
 * Only `findBySlug` is reachable from this use case; the rest throw so a
 * future call site that starts using one is loud rather than silently
 * answered — the shape `community-feed.test.ts` established.
 */
class FakeCommunities implements CommunityRepositoryPort {
  constructor(private readonly rows: CommunityRecord[]) {}
  async findBySlug(slug: string): Promise<CommunityRecord | null> {
    return this.rows.find((row) => row.slug === slug) ?? null;
  }
  private unused(): never {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<never> {
    return this.unused();
  }
  async isMember(): Promise<never> {
    return this.unused();
  }
  async create(): Promise<never> {
    return this.unused();
  }
  async browse(): Promise<never> {
    return this.unused();
  }
  async setTags(): Promise<never> {
    return this.unused();
  }
  async popularTags(): Promise<never> {
    return this.unused();
  }
  async memberCountFor(): Promise<never> {
    return this.unused();
  }
  async join(): Promise<never> {
    return this.unused();
  }
  async leave(): Promise<never> {
    return this.unused();
  }
  async listMembers(): Promise<never> {
    return this.unused();
  }
  /** Phase 8b. Not reached by these tests — direct messages have their own suite. */
  async sharesCommunityWith() {
    return false;
  }
}

/** Records the range it was asked for, which is the whole point of the WIB tests. */
class FakeEvents implements EventRepositoryPort {
  asked: { communityId: string; from: Date; to: Date }[] = [];
  constructor(private readonly rows: EventRow[] = []) {}
  async listBetween(communityId: string, from: Date, to: Date): Promise<EventRow[]> {
    this.asked.push({ communityId, from, to });
    return this.rows;
  }
}

function anEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    postId: "33333333-0000-4000-8000-000000000000",
    title: "Trigonometri lanjutan",
    startsAt: new Date("2026-09-15T09:00:00.000Z"),
    endsAt: null,
    location: null,
    authorHandle: "pakandi",
    authorDisplayName: "Pak Andi",
    ...overrides,
  };
}

function createSubject(rows: EventRow[] = [], now = new Date("2026-09-04T03:00:00.000Z")) {
  const events = new FakeEvents(rows);
  const clock: ClockPort = { now: () => now };
  return {
    events,
    useCase: new ListCommunityEvents(
      new FakeCommunities([community()]),
      events,
      clock
    ),
  };
}

describe("ListCommunityEvents", () => {
  test("an unknown slug is a NotFoundError, and nothing is queried", async () => {
    const { events, useCase } = createSubject();

    await expect(useCase.execute({ slug: "tidak-ada", month: "2026-09" })).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(events.asked).toEqual([]);
  });

  test("the named month is asked for as a WIB range", async () => {
    const { events, useCase } = createSubject();

    await useCase.execute({ slug: "kelas-fisika", month: "2026-09" });

    expect(events.asked).toHaveLength(1);
    expect(events.asked[0]!.communityId).toBe(COMMUNITY_ID);
    expect(events.asked[0]!.from.toISOString()).toBe("2026-08-31T17:00:00.000Z");
    expect(events.asked[0]!.to.toISOString()).toBe("2026-09-30T17:00:00.000Z");
  });

  /**
   * At the boundary, because that is the only place the rule can be wrong:
   * 00:30 WIB on 1 September is still August in UTC, so a clock read as UTC
   * would answer with August's range.
   */
  test("an absent month is the WIB month containing the injected now", async () => {
    const { events, useCase } = createSubject([], new Date("2026-08-31T17:30:00.000Z"));

    await useCase.execute({ slug: "kelas-fisika", month: undefined });

    expect(events.asked[0]!.from.toISOString()).toBe("2026-08-31T17:00:00.000Z");
    expect(events.asked[0]!.to.toISOString()).toBe("2026-09-30T17:00:00.000Z");
  });

  test("projects each row, with the author nested and no body", async () => {
    const { useCase } = createSubject([
      anEvent({
        endsAt: new Date("2026-09-15T11:00:00.000Z"),
        location: "Online via Zoom",
      }),
    ]);

    const { events } = await useCase.execute({ slug: "kelas-fisika", month: "2026-09" });

    expect(events).toHaveLength(1);
    // The EXACT wire shape — the closed-projection discipline every other
    // view in this app is held to.
    expect(Object.keys(events[0]!).sort()).toEqual([
      "author",
      "endsAt",
      "location",
      "postId",
      "startsAt",
      "title",
    ]);
    expect(events[0]!.startsAt).toBe("2026-09-15T09:00:00.000Z");
    expect(events[0]!.endsAt).toBe("2026-09-15T11:00:00.000Z");
    expect(events[0]!.author).toEqual({ handle: "pakandi", displayName: "Pak Andi" });
  });

  test("endsAt and location are explicitly null, never absent", async () => {
    const { useCase } = createSubject([anEvent()]);

    const { events } = await useCase.execute({ slug: "kelas-fisika", month: "2026-09" });

    expect(events[0]!.endsAt).toBeNull();
    expect(events[0]!.location).toBeNull();
  });

  test("a month with no events is an empty list, not a 404", async () => {
    const { useCase } = createSubject([]);

    expect(await useCase.execute({ slug: "kelas-fisika", month: "2026-11" })).toEqual({ events: [] });
  });
});
