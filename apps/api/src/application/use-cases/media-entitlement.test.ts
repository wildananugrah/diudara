import { describe, expect, it } from "bun:test";
import type { ClockPort } from "../ports/clock.port";
import type { MediaRepositoryPort, MediaRow } from "../ports/media-repository.port";
import type { PostGating, PostRepositoryPort } from "../ports/post-repository.port";
import type {
  UserSubscriptionRepositoryPort,
  UserSubscriptionRow,
} from "../ports/user-subscription-repository.port";
import { MediaEntitlement } from "./media-entitlement";

/** The creator whose post is gated. */
const RINA = "44444444-0000-4000-8000-000000000000";
/** Somebody who is not RINA — the person at the gate. */
const BUYER = "55555555-0000-4000-8000-000000000000";
/** A third party who pays nobody. */
const STRANGER = "88888888-0000-4000-8000-000000000000";
const MEDIA_ID = "eeeeeee1-0000-4000-8000-000000000000";
const POST_ID = "aaaaaaaa-0000-4000-8000-000000000000";
const NOW = new Date("2026-08-21T09:00:00.000Z");

/**
 * A clock that COUNTS its reads and moves an hour on every one — the same fake
 * `read-posts.test.ts` uses, and for the same reason.
 *
 * Phase 5b shipped a residual defect caused by a use case calling `clock.now()`
 * twice around a query: a membership whose period ended between the two reads
 * was answered inconsistently. `calls` pins that this class reads the clock
 * exactly once per decision, and moving the instant on each read is what makes
 * a second read VISIBLE in the `now` the gate query receives rather than
 * silently identical.
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

function mediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: MEDIA_ID,
    ownerId: RINA,
    postId: POST_ID,
    position: 0,
    width: 1600,
    height: 900,
    byteSize: 123456,
    createdAt: new Date("2026-08-18T02:00:00.000Z"),
    ...overrides,
  };
}

/** Answers `findById` for exactly one id, and records what it was asked for. */
class FakeMedia implements MediaRepositoryPort {
  row: MediaRow | null = mediaRow();
  findByIdCalls: string[] = [];

  async findById(id: string): Promise<MediaRow | null> {
    this.findByIdCalls.push(id);
    return this.row;
  }
  private unused(): never {
    throw new Error("not used in these tests");
  }
  async create(): Promise<never> {
    return this.unused();
  }
  async findManyByIds(): Promise<never> {
    return this.unused();
  }
  async claim(): Promise<never> {
    return this.unused();
  }
  async listForPost(): Promise<never> {
    return this.unused();
  }
  async listForPosts(): Promise<never> {
    return this.unused();
  }
  async listUnclaimedBefore(): Promise<never> {
    return this.unused();
  }
  async deleteIfUnclaimed(): Promise<never> {
    return this.unused();
  }
}

class FakePosts implements PostRepositoryPort {
  gating: PostGating | null = { authorId: RINA, visibility: "members" };
  gatingCalls: string[] = [];

  async gatingOf(id: string): Promise<PostGating | null> {
    this.gatingCalls.push(id);
    return this.gating;
  }
  private unused(): never {
    throw new Error("not used in these tests");
  }
  async create(): Promise<never> {
    return this.unused();
  }
  /**
   * Throws rather than answering. `ownershipOf` is the edit/delete path's
   * question and carries `isDeleted`; the gate must never read it, because
   * §6.3 settles that a soft-deleted post's images keep being served.
   */
  async ownershipOf(): Promise<never> {
    return this.unused();
  }
  /** Same reason as `ownershipOf` just above: the gate never edits. */
  async lockForEdit(): Promise<never> {
    return this.unused();
  }
  async updateBody(): Promise<never> {
    return this.unused();
  }
  async softDelete(): Promise<never> {
    return this.unused();
  }
  async listGlobal(): Promise<never> {
    return this.unused();
  }
  async listFollowing(): Promise<never> {
    return this.unused();
  }
  async listByAuthor(): Promise<never> {
    return this.unused();
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
 * **The one fake here a wrong implementation could hide behind.**
 *
 * `listActiveOwnersAmong` mirrors the real query's predicate EXACTLY —
 * `status = 'active'` AND `current_period_end > now`, strict — because that
 * predicate is the only thing standing between the lapsed-member test below
 * and a green run against a completely broken gate. A fake filtering on
 * `status` alone, or one that handed back every id it was given, would let
 * this whole file pass while the paywall admitted anyone who had ever paid.
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
  async create(): Promise<never> {
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

function build() {
  const media = new FakeMedia();
  const posts = new FakePosts();
  const subscriptions = new FakeSubscriptions();
  const clock = new CountingClock(NOW);
  return {
    media,
    posts,
    subscriptions,
    clock,
    gate: new MediaEntitlement(media, posts, subscriptions, clock),
  };
}

describe("MediaEntitlement — barrier two", () => {
  it("refuses a gated image to a signed-out viewer", async () => {
    const { gate } = build();

    expect(await gate.decide({ mediaId: MEDIA_ID, viewerId: null })).toEqual({
      allowed: false,
      gated: true,
    });
  });

  it("refuses a gated image to a signed-in viewer who pays for nobody", async () => {
    const { gate } = build();

    expect(await gate.decide({ mediaId: MEDIA_ID, viewerId: STRANGER })).toEqual({
      allowed: false,
      gated: true,
    });
  });

  /**
   * The row still reads `status = 'active'` — nothing has retired it, and 5b's
   * sweep may not run for hours. A status-only check would serve this person
   * every gated image they have stopped paying for.
   */
  it("refuses a LAPSED member — the period is what decides, not the status", async () => {
    const { gate, subscriptions } = build();
    subscriptions.rows = [
      subscriptionRow({ status: "active", currentPeriodEnd: new Date("2026-08-20T09:00:00.000Z") }),
    ];

    expect(await gate.decide({ mediaId: MEDIA_ID, viewerId: BUYER })).toEqual({
      allowed: false,
      gated: true,
    });
  });

  it("allows a paying member, and still marks the media gated", async () => {
    const { gate, subscriptions } = build();
    subscriptions.rows = [subscriptionRow()];

    expect(await gate.decide({ mediaId: MEDIA_ID, viewerId: BUYER })).toEqual({
      allowed: true,
      gated: true,
    });
  });

  /**
   * `gated` describes the MEDIA, not the caller. The author gets their bytes
   * and the route still answers `private, no-store`: an author's browser cache
   * is shared with whoever else uses that device.
   */
  it("allows the author of the gated post, and still marks the media gated", async () => {
    const { gate } = build();

    expect(await gate.decide({ mediaId: MEDIA_ID, viewerId: RINA })).toEqual({
      allowed: true,
      gated: true,
    });
  });

  it("never asks the subscription repository about the author's own image", async () => {
    const { gate, subscriptions } = build();

    await gate.decide({ mediaId: MEDIA_ID, viewerId: RINA });

    // Nobody subscribes to themselves (`user_subscription_no_self` makes the
    // row impossible), so the query could not answer yes — it would be a round
    // trip on every image a creator loads of their own post.
    expect(subscriptions.amongCalls).toEqual([]);
  });

  it("asks about the POST's author, not the media row's owner, and only about them", async () => {
    const { gate, subscriptions, media } = build();
    // An image uploaded by one person and posted by another: the gate must
    // follow the POST, because the post is what carries the visibility.
    media.row = mediaRow({ ownerId: STRANGER });

    await gate.decide({ mediaId: MEDIA_ID, viewerId: BUYER });

    expect(subscriptions.amongCalls).toEqual([
      { subscriberId: BUYER, ownerIds: [RINA], now: NOW },
    ]);
  });

  it("allows a PUBLIC post's image to anyone, ungated, without a membership query", async () => {
    const { gate, posts, subscriptions } = build();
    posts.gating = { authorId: RINA, visibility: "public" };

    expect(await gate.decide({ mediaId: MEDIA_ID, viewerId: null })).toEqual({
      allowed: true,
      gated: false,
    });
    expect(subscriptions.amongCalls).toEqual([]);
  });

  /**
   * `PostRow.visibility` is a widened string so a new value needs no
   * migration, which means an unrecognised one — a typo, a future tier name —
   * reads as NOT gated. Pinned here so that stays a deliberate choice: the
   * write path is the authority on what may be stored.
   */
  it("treats an unrecognised visibility as ungated, matching the projection", async () => {
    const { gate, posts } = build();
    posts.gating = { authorId: RINA, visibility: "Members" };

    expect(await gate.decide({ mediaId: MEDIA_ID, viewerId: null })).toEqual({
      allowed: true,
      gated: false,
    });
  });

  /**
   * Spec §6.3. Bytes uploaded but not yet attached to a post have no post and
   * therefore no visibility to read. The id is known only to its uploader, and
   * the composer previews the image between the upload and the post that
   * claims it — gating this would break that with nothing to gain.
   */
  it("allows UNCLAIMED media, ungated, and never looks for a post", async () => {
    const { gate, posts, media } = build();
    media.row = mediaRow({ postId: null });

    expect(await gate.decide({ mediaId: MEDIA_ID, viewerId: null })).toEqual({
      allowed: true,
      gated: false,
    });
    expect(posts.gatingCalls).toEqual([]);
  });

  it("refuses an id with no media row at all — absent and gated answer alike", async () => {
    const { gate, media } = build();
    media.row = null;

    expect(await gate.decide({ mediaId: MEDIA_ID, viewerId: RINA })).toEqual({
      allowed: false,
      gated: true,
    });
  });

  /**
   * Unreachable today — posts are soft-deleted, never removed — and refused
   * rather than opened anyway. The failure direction of a bug in this class
   * must be "locked out", never "let in".
   */
  it("refuses a claimed image whose post cannot be read", async () => {
    const { gate, posts } = build();
    posts.gating = null;

    expect(await gate.decide({ mediaId: MEDIA_ID, viewerId: RINA })).toEqual({
      allowed: false,
      gated: true,
    });
  });

  it("resolves the media row from the id it was given, never from anything handed in", async () => {
    const { gate, media, posts } = build();

    await gate.decide({ mediaId: MEDIA_ID, viewerId: BUYER });

    expect(media.findByIdCalls).toEqual([MEDIA_ID]);
    expect(posts.gatingCalls).toEqual([POST_ID]);
  });

  /**
   * ONE read of the clock per decision, and the instant is passed down.
   * `CountingClock` moves an hour on every read, so a second read would show
   * up as a different `now` in `amongCalls` as well as a `calls` of 2.
   */
  it("reads the clock exactly once and passes that instant to the membership query", async () => {
    const { gate, clock, subscriptions } = build();

    await gate.decide({ mediaId: MEDIA_ID, viewerId: BUYER });

    expect(clock.calls).toBe(1);
    expect(subscriptions.amongCalls.map((call) => call.now)).toEqual([NOW]);
  });

  /**
   * A membership buys that creator's gated images and nothing else. The port
   * promises never to answer an id outside `ownerIds`; a gate that trusted the
   * COUNT instead of the id would be one repository bug away from unlocking
   * every creator at once.
   */
  it("refuses when the membership query answers an owner other than this post's author", async () => {
    const { gate, subscriptions } = build();
    subscriptions.listActiveOwnersAmong = async () => [STRANGER];

    expect(await gate.decide({ mediaId: MEDIA_ID, viewerId: BUYER })).toEqual({
      allowed: false,
      gated: true,
    });
  });
});
