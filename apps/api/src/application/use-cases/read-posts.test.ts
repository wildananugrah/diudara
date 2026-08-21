import { describe, expect, it } from "bun:test";
import { NotFoundError } from "../errors";
import type { ClockPort } from "../ports/clock.port";
import type { MediaRepositoryPort, MediaRow } from "../ports/media-repository.port";
import type { PostRepositoryPort, PostRow } from "../ports/post-repository.port";
import type {
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
} from "../ports/user-subscription-repository.port";
import type { UserRecord, UserRepositoryPort } from "../ports/user-repository.port";
import { ListFeed, ListUserPosts } from "./read-posts";

function fakeRow(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000000",
    body: "halo",
    createdAt: new Date("2026-08-18T03:00:00.000Z"),
    editedAt: null,
    // Distinct from VIEWER (below) and from fakeUser's default id — a
    // fixture where the author id happened to equal the viewer id would
    // make a later gate test pass for the wrong reason.
    authorId: "99999999-0000-4000-8000-000000000000",
    visibility: "public",
    authorHandle: "budi",
    authorDisplayName: "Budi",
    ...overrides,
  };
}

const VIEWER = "11111111-0000-4000-8000-000000000000";

/**
 * Records every call made to each list method — the only way to assert
 * `ListFeed`/`ListUserPosts` called the RIGHT repository method with the
 * RIGHT arguments, rather than merely that some page came back.
 */
class FakePosts implements PostRepositoryPort {
  globalCalls: Array<{ limit: number; before: unknown }> = [];
  followingCalls: Array<{ viewerId: string; limit: number; before: unknown }> = [];
  byAuthorCalls: Array<{ authorId: string; limit: number; before: unknown }> = [];
  rows: PostRow[] = [];

  async create(): Promise<PostRow> {
    return fakeRow();
  }
  async ownershipOf() {
    return null;
  }
  async updateBody(): Promise<PostRow | null> {
    return null;
  }
  async softDelete(): Promise<void> {}
  async listGlobal(limit: number, before: unknown): Promise<PostRow[]> {
    this.globalCalls.push({ limit, before });
    return this.rows;
  }
  async listFollowing(viewerId: string, limit: number, before: unknown): Promise<PostRow[]> {
    this.followingCalls.push({ viewerId, limit, before });
    return this.rows;
  }
  async listByAuthor(authorId: string, limit: number, before: unknown): Promise<PostRow[]> {
    this.byAuthorCalls.push({ authorId, limit, before });
    return this.rows;
  }
}

/**
 * Records every `listForPosts` call, because the thing worth asserting about
 * media on a feed is not that it arrives but that it costs ONE query for the
 * whole page — a per-row lookup is 20 round trips per feed page.
 */
class FakeMedia implements MediaRepositoryPort {
  forPostsCalls: string[][] = [];
  rows: MediaRow[] = [];

  async create(): Promise<MediaRow> {
    throw new Error("not used in these tests");
  }
  async findById(): Promise<MediaRow | null> {
    return null;
  }
  async findManyByIds(): Promise<MediaRow[]> {
    return [];
  }
  async claim(_postId: string, ids: string[]): Promise<number> {
    return ids.length;
  }
  async listForPost(): Promise<MediaRow[]> {
    throw new Error("a feed must never look media up one post at a time");
  }
  async listForPosts(postIds: string[]): Promise<MediaRow[]> {
    this.forPostsCalls.push([...postIds]);
    return this.rows;
  }
  async listUnclaimedBefore(): Promise<MediaRow[]> {
    return [];
  }
  async deleteIfUnclaimed(): Promise<boolean> {
    return false;
  }
}

function fakeMediaRow(overrides: Partial<MediaRow> & { id: string; postId: string }): MediaRow {
  return {
    ownerId: "33333333-0000-4000-8000-000000000000",
    position: 0,
    width: 1600,
    height: 900,
    byteSize: 123456,
    createdAt: new Date("2026-08-18T02:00:00.000Z"),
    ...overrides,
  };
}

class FakeUsers implements UserRepositoryPort {
  users: UserRecord[] = [];

  async create(): Promise<UserRecord> {
    throw new Error("not used in these tests");
  }
  async findByHandle(handle: string): Promise<UserRecord | null> {
    return this.users.find((u) => u.handle === handle) ?? null;
  }
  async findById(): Promise<UserRecord | null> {
    return null;
  }
  async findByEmail(): Promise<UserRecord | null> {
    return null;
  }
  async findCredentialsByEmail() {
    return null;
  }
  async setPasswordAndBumpEpoch(): Promise<boolean> {
    return false;
  }
  async updateProfile(): Promise<UserRecord | null> {
    return null;
  }
  async searchPublic() {
    return [];
  }
  async newestPublic() {
    return [];
  }
  async mostFollowedPublic() {
    return [];
  }
}

function fakeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "22222222-0000-4000-8000-000000000000",
    handle: "budi",
    email: "budi@example.com",
    whatsappNumber: null,
    displayName: "Budi",
    bio: null,
    sessionEpoch: 0,
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
    ...overrides,
  };
}

/** The creator whose post is gated. Distinct from every other id in this file. */
const RINA = "44444444-0000-4000-8000-000000000000";
/** Somebody who is not RINA and not the default author — the person at the gate. */
const BUYER = "55555555-0000-4000-8000-000000000000";
const NOW = new Date("2026-08-21T09:00:00.000Z");

/**
 * A clock that COUNTS its reads and moves an hour on every one.
 *
 * Both halves are load-bearing. Phase 5b shipped a residual defect caused by a
 * use case calling `clock.now()` twice around a query — a membership whose
 * period ended between the two reads was answered inconsistently — so `calls`
 * pins that this one reads it exactly once per page. Moving the instant on
 * each read is what makes a second read visible in the `now` the gate query
 * receives, rather than silently identical.
 */
class CountingClock implements ClockPort {
  calls = 0;
  constructor(private instant: Date) {}
  now(): Date {
    this.calls += 1;
    const read = new Date(this.instant);
    this.instant = new Date(this.instant.getTime() + 3_600_000);
    return read;
  }
}

function subscriptionRow(overrides: Partial<UserSubscriptionRow> = {}): UserSubscriptionRow {
  return {
    id: "66666666-0000-4000-8000-000000000000",
    subscriberId: BUYER,
    tierId: "77777777-0000-4000-8000-000000000000",
    ownerId: RINA,
    status: "active",
    currentPeriodEnd: new Date("2026-09-21T09:00:00.000Z"),
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    ...overrides,
  };
}

/**
 * **The one fake in this file that a wrong implementation would hide behind.**
 *
 * `listActiveOwnersAmong` mirrors the real query's predicate EXACTLY —
 * `status = 'active'` AND `current_period_end > now`, strict — because that is
 * the only thing standing between the lapsed-member test below and a green run
 * against a completely broken gate. A fake that filtered on `status` alone, or
 * that simply handed back every id it was given, would let this whole file pass
 * while the paywall admitted anyone who had ever paid. Verified by mutating it
 * to `return ownerIds` and confirming the lapsed test reddens.
 *
 * Every other method throws rather than answering: this file exercises exactly
 * one of them, and a stub that returned a plausible value would be a second
 * place for a wrong answer to come from.
 */
class FakeSubscriptions implements UserSubscriptionRepositoryPort {
  rows: UserSubscriptionRow[] = [];
  amongCalls: Array<{ subscriberId: string; ownerIds: string[]; now: Date }> = [];

  async listActiveOwnersAmong(
    subscriberId: string,
    ownerIds: string[],
    now: Date
  ): Promise<string[]> {
    this.amongCalls.push({ subscriberId, ownerIds: [...ownerIds], now });
    const wanted = new Set(ownerIds);
    return this.rows
      .filter(
        (r) =>
          r.subscriberId === subscriberId &&
          wanted.has(r.ownerId) &&
          r.status === "active" &&
          r.currentPeriodEnd !== null &&
          r.currentPeriodEnd > now
      )
      .map((r) => r.ownerId);
  }

  private unused(): never {
    throw new Error("not used in these tests");
  }
  async create(): Promise<UserSubscriptionRow> {
    return this.unused();
  }
  async claimPending(): Promise<never> {
    return this.unused();
  }
  async findById(): Promise<never> {
    return this.unused();
  }
  async activate(): Promise<never> {
    return this.unused();
  }
  async cancel(): Promise<never> {
    return this.unused();
  }
  async retireExpired(): Promise<never> {
    return this.unused();
  }
  async listExpiredActive(): Promise<never> {
    return this.unused();
  }
  async listStalePending(): Promise<never> {
    return this.unused();
  }
  async expireStalePending(): Promise<never> {
    return this.unused();
  }
  async findExpirableInvoice(): Promise<never> {
    return this.unused();
  }
  async listExpiringActive(): Promise<never> {
    return this.unused();
  }
  async findActiveFor(): Promise<never> {
    return this.unused();
  }
  async listActiveSubscribers(): Promise<never> {
    return this.unused();
  }
  async createTransaction(): Promise<never> {
    return this.unused();
  }
  async findTransactionById(): Promise<never> {
    return this.unused();
  }
  async attachGatewayReference(): Promise<never> {
    return this.unused();
  }
  async findPendingCheckout(): Promise<never> {
    return this.unused();
  }
  async markTransactionPaid(): Promise<never> {
    return this.unused();
  }
}

/** RINA's gated post, with two images behind the lock. */
function gatedPage(): { posts: FakePosts; media: FakeMedia } {
  const posts = new FakePosts();
  posts.rows = [
    fakeRow({
      id: "aaaaaaaa-0000-4000-8000-000000000000",
      body: "Behind the scenes",
      authorId: RINA,
      visibility: "members",
    }),
  ];
  const media = new FakeMedia();
  media.rows = [
    fakeMediaRow({
      id: "eeeeeee1-0000-4000-8000-000000000000",
      postId: "aaaaaaaa-0000-4000-8000-000000000000",
    }),
    fakeMediaRow({
      id: "eeeeeee2-0000-4000-8000-000000000000",
      postId: "aaaaaaaa-0000-4000-8000-000000000000",
      position: 1,
    }),
  ];
  return { posts, media };
}

describe("ListFeed", () => {
  it("untuk-anda calls listGlobal, never listFollowing", async () => {
    const posts = new FakePosts();
    await new ListFeed(posts, new FakeMedia(), new FakeSubscriptions(), new CountingClock(NOW)).execute({
      tab: "untuk-anda",
      viewerId: null,
      limit: 20,
      before: null,
    });

    expect(posts.globalCalls).toHaveLength(1);
    expect(posts.followingCalls).toHaveLength(0);
  });

  it("untuk-anda asks the repository for limit + 1 — the LITERAL 21 with no limit given", async () => {
    const posts = new FakePosts();
    await new ListFeed(posts, new FakeMedia(), new FakeSubscriptions(), new CountingClock(NOW)).execute({ tab: "untuk-anda", viewerId: null, before: null });

    expect(posts.globalCalls).toEqual([{ limit: 21, before: null }]);
  });

  it("mengikuti calls listFollowing with the viewer id, never listGlobal", async () => {
    const posts = new FakePosts();
    await new ListFeed(posts, new FakeMedia(), new FakeSubscriptions(), new CountingClock(NOW)).execute({
      tab: "mengikuti",
      viewerId: VIEWER,
      limit: 20,
      before: null,
    });

    expect(posts.followingCalls).toEqual([{ viewerId: VIEWER, limit: 21, before: null }]);
    expect(posts.globalCalls).toHaveLength(0);
  });

  it("passes the cursor through to the repository untouched", async () => {
    const posts = new FakePosts();
    const cursor = { timestamp: new Date("2026-08-18T00:00:00.000Z"), id: "x" };
    await new ListFeed(posts, new FakeMedia(), new FakeSubscriptions(), new CountingClock(NOW)).execute({
      tab: "untuk-anda",
      viewerId: null,
      limit: 20,
      before: cursor,
    });

    expect(posts.globalCalls[0]?.before).toBe(cursor);
  });

  /**
   * ONE query for the whole page, not one per post — `listForPosts` exists for
   * exactly this, and the ids it is given are the ids the repository just
   * returned.
   */
  it("fetches the page's media in a SINGLE listForPosts call", async () => {
    const posts = new FakePosts();
    posts.rows = [
      fakeRow({ id: "aaaaaaaa-0000-4000-8000-000000000000" }),
      fakeRow({ id: "bbbbbbbb-0000-4000-8000-000000000000" }),
    ];
    const media = new FakeMedia();

    await new ListFeed(posts, media, new FakeSubscriptions(), new CountingClock(NOW)).execute({
      tab: "untuk-anda",
      viewerId: null,
      limit: 20,
      before: null,
    });

    expect(media.forPostsCalls).toEqual([
      [
        "aaaaaaaa-0000-4000-8000-000000000000",
        "bbbbbbbb-0000-4000-8000-000000000000",
      ],
    ]);
  });

  it("hands each post its own images", async () => {
    const posts = new FakePosts();
    posts.rows = [
      fakeRow({ id: "aaaaaaaa-0000-4000-8000-000000000000" }),
      fakeRow({ id: "bbbbbbbb-0000-4000-8000-000000000000" }),
    ];
    const media = new FakeMedia();
    media.rows = [
      fakeMediaRow({
        id: "cccccccc-0000-4000-8000-000000000000",
        postId: "bbbbbbbb-0000-4000-8000-000000000000",
      }),
    ];

    const page = await new ListFeed(posts, media, new FakeSubscriptions(), new CountingClock(NOW)).execute({
      tab: "untuk-anda",
      viewerId: null,
      limit: 20,
      before: null,
    });

    expect(page.posts[0]!.media).toEqual([]);
    expect(page.posts[1]!.media).toEqual([
      { id: "cccccccc-0000-4000-8000-000000000000", width: 1600, height: 900 },
    ]);
  });
});

describe("ListUserPosts", () => {
  it("throws NotFoundError for an unknown handle, and never calls listByAuthor", async () => {
    const posts = new FakePosts();
    const users = new FakeUsers();

    await expect(
      new ListUserPosts(users, posts, new FakeMedia(), new FakeSubscriptions(), new CountingClock(NOW)).execute({ handle: "tidak-ada", viewerId: null, before: null })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(posts.byAuthorCalls).toHaveLength(0);
  });

  it("resolves the handle and lists that author's posts with limit + 1", async () => {
    const posts = new FakePosts();
    const users = new FakeUsers();
    users.users.push(fakeUser({ handle: "budi" }));

    await new ListUserPosts(users, posts, new FakeMedia(), new FakeSubscriptions(), new CountingClock(NOW)).execute({ handle: "budi", viewerId: null, limit: 20, before: null });

    expect(posts.byAuthorCalls).toEqual([
      { authorId: "22222222-0000-4000-8000-000000000000", limit: 21, before: null },
    ]);
  });

  it("normalises the handle (leading @, mixed case) before the lookup", async () => {
    const posts = new FakePosts();
    const users = new FakeUsers();
    users.users.push(fakeUser({ handle: "budi" }));

    const page = await new ListUserPosts(users, posts, new FakeMedia(), new FakeSubscriptions(), new CountingClock(NOW)).execute({ handle: "@Budi", viewerId: null, before: null });
    expect(page.posts).toEqual([]);
    expect(posts.byAuthorCalls).toHaveLength(1);
  });

  it("fetches the author page's media in a SINGLE listForPosts call", async () => {
    const posts = new FakePosts();
    posts.rows = [fakeRow({ id: "aaaaaaaa-0000-4000-8000-000000000000" })];
    const users = new FakeUsers();
    users.users.push(fakeUser({ handle: "budi" }));
    const media = new FakeMedia();

    await new ListUserPosts(users, posts, media, new FakeSubscriptions(), new CountingClock(NOW)).execute({ handle: "budi", viewerId: null, before: null });

    expect(media.forPostsCalls).toEqual([["aaaaaaaa-0000-4000-8000-000000000000"]]);
  });
});

/**
 * **BARRIER ONE.** The projection must never send a media id to a non-member.
 * Not a partial list, not an id with the url withheld: `/users/media/:id` is
 * derived from the id, so an id that leaves this process IS the url. Task 4
 * builds the second barrier at the media route, which refuses an id it did not
 * send; neither is sufficient alone (spec §6.4).
 */
describe("ListFeed — the paywall gate", () => {
  it("a signed-out reader gets the caption and no media for a members-only post", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();

    const page = await new ListFeed(posts, media, subscriptions, new CountingClock(NOW)).execute({
      tab: "untuk-anda",
      viewerId: null,
      limit: 10,
      before: null,
    });

    expect(page.posts[0]?.body).toBe("Behind the scenes");
    expect(page.posts[0]?.media).toEqual([]);
    expect(page.posts[0]?.membersOnly).toBe(true);
    expect(page.posts[0]?.lockedMediaCount).toBe(2);
  });

  /**
   * A signed-out viewer has nothing to look up: there is no subscriber id to
   * ask about. Asking anyway would be a wasted round trip on the busiest page
   * in the product, and — worse — a query whose only possible answer is
   * "nobody" is a place where a future edit could invent one.
   */
  it("a signed-out viewer never asks the membership question at all", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();

    await new ListFeed(posts, media, subscriptions, new CountingClock(NOW)).execute({
      tab: "untuk-anda",
      viewerId: null,
      limit: 10,
      before: null,
    });

    expect(subscriptions.amongCalls).toEqual([]);
  });

  it("a paying member gets the media", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();
    subscriptions.rows = [subscriptionRow()];

    const page = await new ListFeed(posts, media, subscriptions, new CountingClock(NOW)).execute({
      tab: "untuk-anda",
      viewerId: BUYER,
      limit: 10,
      before: null,
    });

    expect(page.posts[0]?.media.map((m) => m.id)).toEqual([
      "eeeeeee1-0000-4000-8000-000000000000",
      "eeeeeee2-0000-4000-8000-000000000000",
    ]);
    expect(page.posts[0]?.membersOnly).toBe(true);
    expect(page.posts[0]?.lockedMediaCount).toBe(0);
  });

  /**
   * **Where Phase 5b's retirement work becomes visible.** The row still reads
   * `status = 'active'` — nothing has retired it yet, and the sweep may not run
   * for hours (5b spec §9's honest limitation) — so a status-only check would
   * hand a lapsed member every gated image they no longer pay for. The date is
   * the whole test.
   */
  it("a LAPSED member does NOT get the media — their period ended", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();
    subscriptions.rows = [
      subscriptionRow({ status: "active", currentPeriodEnd: new Date("2026-08-20T09:00:00.000Z") }),
    ];

    const page = await new ListFeed(posts, media, subscriptions, new CountingClock(NOW)).execute({
      tab: "untuk-anda",
      viewerId: BUYER,
      limit: 10,
      before: null,
    });

    expect(page.posts[0]?.media).toEqual([]);
    expect(page.posts[0]?.lockedMediaCount).toBe(2);
  });

  it("the AUTHOR always gets their own media, member or not", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();

    const page = await new ListFeed(posts, media, subscriptions, new CountingClock(NOW)).execute({
      tab: "untuk-anda",
      viewerId: RINA,
      limit: 10,
      before: null,
    });

    expect(page.posts[0]?.media.map((m) => m.id)).toEqual([
      "eeeeeee1-0000-4000-8000-000000000000",
      "eeeeeee2-0000-4000-8000-000000000000",
    ]);
  });

  /**
   * The author is not merely unlocked, they are never ASKED about: a feed of
   * one's own gated posts must not turn into a membership query per page for a
   * membership that cannot exist (nobody subscribes to themselves).
   */
  it("does not ask the membership question when the only gated post is the viewer's own", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();

    await new ListFeed(posts, media, subscriptions, new CountingClock(NOW)).execute({
      tab: "untuk-anda",
      viewerId: RINA,
      limit: 10,
      before: null,
    });

    expect(subscriptions.amongCalls).toEqual([]);
  });

  /**
   * ONE membership query for the whole page, whatever the page size — the same
   * reason `listForPosts` exists. Asking per post would be a query per author
   * on the page that matters most (spec §6.1).
   */
  it("asks the membership question ONCE for the page, with each gated author named once", async () => {
    const posts = new FakePosts();
    posts.rows = [
      fakeRow({ id: "aaaaaaaa-0000-4000-8000-000000000000", authorId: RINA, visibility: "members" }),
      fakeRow({ id: "bbbbbbbb-0000-4000-8000-000000000000", authorId: RINA, visibility: "members" }),
      fakeRow({ id: "cccccccc-0000-4000-8000-000000000000", authorId: BUYER, visibility: "public" }),
    ];
    const subscriptions = new FakeSubscriptions();

    await new ListFeed(posts, new FakeMedia(), subscriptions, new CountingClock(NOW)).execute({
      tab: "untuk-anda",
      viewerId: BUYER,
      limit: 10,
      before: null,
    });

    expect(subscriptions.amongCalls).toHaveLength(1);
    expect(subscriptions.amongCalls[0]?.subscriberId).toBe(BUYER);
    expect(subscriptions.amongCalls[0]?.ownerIds).toEqual([RINA]);
  });

  /**
   * Phase 5b shipped a residual defect from a use case reading `clock.now()`
   * twice around a query. `CountingClock` moves an hour on every read, so a
   * second read would both bump `calls` and hand the query an instant nobody
   * chose.
   */
  it("reads the clock ONCE per page and hands that instant to the query", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();
    const clock = new CountingClock(NOW);

    await new ListFeed(posts, media, subscriptions, clock).execute({
      tab: "untuk-anda",
      viewerId: BUYER,
      limit: 10,
      before: null,
    });

    expect(clock.calls).toBe(1);
    expect(subscriptions.amongCalls[0]?.now.toISOString()).toBe("2026-08-21T09:00:00.000Z");
  });

  it("gates the mengikuti tab too, not only untuk-anda", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();

    const page = await new ListFeed(posts, media, subscriptions, new CountingClock(NOW)).execute({
      tab: "mengikuti",
      viewerId: BUYER,
      limit: 10,
      before: null,
    });

    expect(page.posts[0]?.media).toEqual([]);
    expect(page.posts[0]?.lockedMediaCount).toBe(2);
  });
});

describe("ListUserPosts — the paywall gate", () => {
  function usersHolding(handle: string): FakeUsers {
    const users = new FakeUsers();
    users.users.push(fakeUser({ id: RINA, handle }));
    return users;
  }

  it("a signed-out reader gets the caption and no media on a profile page", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();

    const page = await new ListUserPosts(
      usersHolding("rina"),
      posts,
      media,
      subscriptions,
      new CountingClock(NOW)
    ).execute({ handle: "rina", viewerId: null, before: null });

    expect(page.posts[0]?.body).toBe("Behind the scenes");
    expect(page.posts[0]?.media).toEqual([]);
    expect(page.posts[0]?.lockedMediaCount).toBe(2);
  });

  it("a paying member gets the media on a profile page", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();
    subscriptions.rows = [subscriptionRow()];

    const page = await new ListUserPosts(
      usersHolding("rina"),
      posts,
      media,
      subscriptions,
      new CountingClock(NOW)
    ).execute({ handle: "rina", viewerId: BUYER, before: null });

    expect(page.posts[0]?.media).toHaveLength(2);
  });

  it("a LAPSED member does NOT get the media on a profile page", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();
    subscriptions.rows = [
      subscriptionRow({ currentPeriodEnd: new Date("2026-08-20T09:00:00.000Z") }),
    ];

    const page = await new ListUserPosts(
      usersHolding("rina"),
      posts,
      media,
      subscriptions,
      new CountingClock(NOW)
    ).execute({ handle: "rina", viewerId: BUYER, before: null });

    expect(page.posts[0]?.media).toEqual([]);
  });

  it("the AUTHOR always gets their own media on their own profile", async () => {
    const { posts, media } = gatedPage();
    const subscriptions = new FakeSubscriptions();

    const page = await new ListUserPosts(
      usersHolding("rina"),
      posts,
      media,
      subscriptions,
      new CountingClock(NOW)
    ).execute({ handle: "rina", viewerId: RINA, before: null });

    expect(page.posts[0]?.media).toHaveLength(2);
    expect(subscriptions.amongCalls).toEqual([]);
  });
});
