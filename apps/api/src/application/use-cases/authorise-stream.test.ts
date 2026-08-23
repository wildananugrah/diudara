import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import {
  appUsers,
  communities,
  creators,
  events,
  members,
  membershipTiers,
  subscriptions,
  userStreams,
} from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleEventRepository } from "../../infrastructure/repositories/drizzle-event.repository";
import { DrizzleSubscriptionRepository } from "../../infrastructure/repositories/drizzle-subscription.repository";
import { DrizzleUserStreamRepository } from "../../infrastructure/repositories/drizzle-user-stream.repository";
import { mintWatchToken, WATCH_TOKEN_TTL_MS } from "../../domain/watch-token";
import {
  mintUserWatchToken,
  USER_WATCH_TOKEN_TTL_MS,
} from "../../domain/user-watch-token";
import { AuthoriseStream, parseStreamPath } from "./authorise-stream";

beforeEach(resetDatabase);

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);
const NOW = Date.parse("2026-08-11T10:00:00.000Z");

const eventRepository = new DrizzleEventRepository(db);
const subscriptionRepository = new DrizzleSubscriptionRepository(db);
const userStreamRepository = new DrizzleUserStreamRepository(db);
const useCase = new AuthoriseStream(
  eventRepository,
  subscriptionRepository,
  userStreamRepository,
  { streamTokenSecret: SECRET }
);

let seedCounter = 0;

/** A fresh community, owned by a fresh creator — the minimum an event needs. */
async function seedCommunity(name = "Rina") {
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
  return community;
}

/** One event in `communityId`, at the given `status`, with a fresh stream key. */
async function seedEvent(communityId: string, status: string) {
  seedCounter += 1;
  const streamKey = `key-${seedCounter}`;
  const [event] = await db
    .insert(events)
    .values({
      communityId,
      title: "Live Q&A",
      streamKey,
      status,
      hlsPlaybackPath: `https://fake-mediamtx.local/live/${streamKey}/index.m3u8`,
    })
    .returning();
  return { event: event!, streamKey };
}

/** An `active` subscription to a fresh tier of `communityId`. */
async function seedActiveSubscription(communityId: string) {
  seedCounter += 1;
  const [tier] = await db
    .insert(membershipTiers)
    .values({ communityId, name: "Basic", priceAmount: 50000, billingCycle: "monthly" })
    .returning();
  const [member] = await db
    .insert(members)
    .values({ whatsappNumber: `+62810${String(seedCounter).padStart(6, "0")}`, name: "Siti" })
    .returning();
  const [subscription] = await db
    .insert(subscriptions)
    .values({ memberId: member!.id, tierId: tier!.id, status: "active" })
    .returning();
  return subscription!;
}

async function cancelSubscription(id: string) {
  await db
    .update(subscriptions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(subscriptions.id, id));
}

function tokenFor(subscriptionId: string, eventId: string, secret = SECRET, now = NOW) {
  return mintWatchToken({ subscriptionId, eventId, now, ttlMs: WATCH_TOKEN_TTL_MS, secret });
}

/** One person, the minimum a `user_stream` row needs as its owner. */
async function seedUser(handle: string) {
  seedCounter += 1;
  const [row] = await db
    .insert(appUsers)
    .values({
      handle: `${handle}${seedCounter}`,
      email: `${handle}${seedCounter}@example.com`,
      whatsappNumber: null,
      passwordHash: "irrelevant-hash",
      displayName: handle,
      bio: null,
    })
    .returning();
  return row!;
}

/**
 * One `live` user stream, with a stream key shaped exactly like a REAL one:
 * 32 lowercase hex characters, which is what `newStreamKey` mints. The shape
 * matters for the refusal test below — a key shaped `key-7` would prove far
 * less about a real deployment than the string a creator actually holds.
 */
async function seedUserStream(visibility: string) {
  const owner = await seedUser("rina");
  const streamKey = seedCounter.toString(16).padStart(32, "b");
  return userStreamRepository.startLive({
    ownerId: owner.id,
    title: "Bedah karya",
    visibility,
    streamKey,
  });
}

/** A user watch token, the Phase 7 kind — `viewerId` + `streamId`, ten minutes. */
function userTokenFor(viewerId: string, streamId: string, secret = SECRET, now = NOW) {
  return mintUserWatchToken({
    viewerId,
    streamId,
    now,
    ttlMs: USER_WATCH_TOKEN_TTL_MS,
    secret,
  });
}

/**
 * The same token with its `viewerId` rewritten and the signature kept — an
 * attempt to present somebody else's credential as your own.
 *
 * FIX ROUND 1, MIN-1: this used to rewrite `streamId`, which meant the two
 * "a TAMPERED token is refused" tests never reached the guard in their name.
 * The forged `streamId` no longer matched the stream being requested, so
 * `claims.streamId !== stream.id` refused FIRST — and both tests stayed green
 * with the signature comparison deleted outright, making them duplicates of
 * "a token minted for ANOTHER stream…" wearing a different name.
 *
 * `viewerId` is the right field to forge precisely because NOTHING downstream
 * reads it (see `user-watch-token.ts`'s own note): the signature is the only
 * thing standing between this token and acceptance, so a test that refuses it
 * is testing the signature and nothing else.
 */
function tamperWith(token: string) {
  const [payload, signature] = token.split(".");
  const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString());
  decoded.viewerId = "99999999-9999-4999-8999-999999999999";
  return `${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;
}

/**
 * `parseStreamPath` is the ONE parser both `AuthoriseStream.execute` and
 * `HandleStreamLifecycle.execute` go through — see its own docstring for
 * why a second, looser parser for the new `u/` namespace would re-open the
 * exact defect `streamKeyFromPath` was hardened against (a publish to
 * `foo/bar/<key>` once authorising exactly as `live/<key>` did).
 */
describe("parseStreamPath", () => {
  it("live/<key> is the community world", () => {
    expect(parseStreamPath("live/abc123")).toEqual({ world: "community", key: "abc123" });
  });

  it("u/<key> is the user world", () => {
    expect(parseStreamPath("u/abc123")).toEqual({ world: "user", key: "abc123" });
  });

  it("an UNKNOWN namespace is refused, never guessed at", () => {
    expect(parseStreamPath("foo/abc123")).toBeNull();
  });

  it("a three-segment path is refused even when its first segment is known", () => {
    expect(parseStreamPath("live/abc123/extra")).toBeNull();
  });

  it("a bare key with no namespace is refused", () => {
    expect(parseStreamPath("abc123")).toBeNull();
  });
});

describe("AuthoriseStream — publish", () => {
  it("allows a publish to a scheduled event", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "scheduled");

    const result = await useCase.execute({
      action: "publish",
      path: `live/${streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(true);
  });

  it("allows a publish to a live event", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "live");

    const result = await useCase.execute({
      action: "publish",
      path: `live/${streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(true);
  });

  it("refuses a publish to an ended event — a finished session must not be republishable", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "ended");

    const result = await useCase.execute({
      action: "publish",
      path: `live/${streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a publish against an unknown stream key", async () => {
    const result = await useCase.execute({
      action: "publish",
      path: "live/no-such-key",
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  /**
   * Review round 2, minor #2: `streamKeyFromPath` used to take the LAST
   * path segment regardless of what came before it, so `foo/bar/<key>`
   * authorised a publish exactly as `live/<key>` did — even though
   * `MediaMtxAdapter.createSession` never constructs anything but
   * `live/<key>`. Not itself an access-control hole (the key still has to
   * be real), but Task 5's `runOnOnline` would then fire with
   * `MTX_PATH=foo/bar/<key>`, marking the event `live` while every
   * member's HLS URL (built from `live/<key>`) points at nothing.
   */
  it("refuses a publish whose path is not under the live/ prefix, even with a real key", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "scheduled");

    const result = await useCase.execute({
      action: "publish",
      path: `foo/bar/${streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });
});

describe("AuthoriseStream — read", () => {
  it("allows a read with a valid token for an active subscription in the event's community", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(true);
  });

  /**
   * THE test this task exists to get right. The token is minted while the
   * subscription is genuinely active — proving it would have worked — and
   * the cancellation is driven BETWEEN the mint and the read, through a real
   * database write, rather than minting a token that was already invalid.
   */
  it("refuses a read once the subscription is cancelled after the token was minted", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    await cancelSubscription(subscription.id);

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a token minted for event A when used against event B's path", async () => {
    const community = await seedCommunity();
    const { streamKey: pathA } = await seedEvent(community.id, "live");
    const { event: eventB } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    // Minted for B...
    const token = tokenFor(subscription.id, eventB.id);

    // ...presented against A's path.
    const result = await useCase.execute({
      action: "read",
      path: `live/${pathA}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses when the subscription's community differs from the event's community", async () => {
    const subscriberCommunity = await seedCommunity("Rina");
    const eventCommunity = await seedCommunity("Budi");
    const { event, streamKey } = await seedEvent(eventCommunity.id, "live");
    const subscription = await seedActiveSubscription(subscriberCommunity.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a read against an unknown stream key even with an otherwise-valid token", async () => {
    const community = await seedCommunity();
    const subscription = await seedActiveSubscription(community.id);
    // eventId does not matter — the path never resolves to any event.
    const token = tokenFor(subscription.id, "00000000-0000-4000-8000-000000000000");

    const result = await useCase.execute({
      action: "read",
      path: "live/no-such-key",
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a read with no token in the query at all", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "live");

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a token signed with the wrong secret", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id, OTHER_SECRET);

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a subscription id that no longer exists at all", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const token = tokenFor("00000000-0000-4000-8000-000000000000", event.id);

    const result = await useCase.execute({
      action: "read",
      path: `live/${streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });
});

/**
 * `authoriseReadByEventId` — the entry point nginx's `auth_request` calls
 * (Task 9, `mediamtx-webhooks.ts`'s `/auth-request` route), added by the
 * final whole-branch review's Critical fix: the public HLS path a member's
 * browser ever requests is now `/live/<eventId>/...`, so the re-auth check
 * on every segment has to resolve by event id, not by stream key — the
 * whole point being that the stream key never has to appear anywhere a
 * member's browser can see it. Mirrors "AuthoriseStream — read" above
 * property-for-property (same token/entitlement checks, same
 * `authoriseReadForEvent` helper under the hood), plus the NEW behaviour:
 * only this entry point ever hands the stream key back out, and only to a
 * caller that already proved entitlement.
 */
describe("AuthoriseStream — read by event id (nginx auth_request)", () => {
  it("allows a read with a valid token, and returns the event's own stream key", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.authoriseReadByEventId({
      eventId: event.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: true, streamKey });
  });

  it("refuses once the subscription is cancelled after the token was minted", async () => {
    const community = await seedCommunity();
    const { event } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    await cancelSubscription(subscription.id);

    const result = await useCase.authoriseReadByEventId({
      eventId: event.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses a token minted for event A when presented against event B's id", async () => {
    const community = await seedCommunity();
    const { event: eventA } = await seedEvent(community.id, "live");
    const { event: eventB } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, eventA.id);

    const result = await useCase.authoriseReadByEventId({
      eventId: eventB.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses when the subscription's community differs from the event's community", async () => {
    const subscriberCommunity = await seedCommunity("Rina");
    const eventCommunity = await seedCommunity("Budi");
    const { event } = await seedEvent(eventCommunity.id, "live");
    const subscription = await seedActiveSubscription(subscriberCommunity.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.authoriseReadByEventId({
      eventId: event.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses an unknown event id even with an otherwise well-formed token", async () => {
    const community = await seedCommunity();
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, "00000000-0000-4000-8000-000000000000");

    const result = await useCase.authoriseReadByEventId({
      eventId: "00000000-0000-4000-8000-000000000000",
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses a read with no token in the query at all", async () => {
    const community = await seedCommunity();
    const { event } = await seedEvent(community.id, "live");

    const result = await useCase.authoriseReadByEventId({ eventId: event.id, query: "", now: NOW });

    expect(result).toEqual({ allowed: false });
  });

  /**
   * The property this task exists to close: presenting a STREAM KEY where
   * this method expects an event id must not accidentally resolve to
   * anything — `findById` and `findByStreamKey` are different lookups
   * against different columns, so a key is simply never a valid id.
   */
  it("refuses when the caller passes a stream key instead of an event id", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.authoriseReadByEventId({
      eventId: streamKey,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });
});

/**
 * THE USER WORLD, through MediaMTX's OWN `authHTTPAddress` hook — the entry
 * point that arrives with `u/<streamKey>`, the path a client actually
 * published to or read from. Task 5.
 *
 * WHAT REPLACED WHAT, so the history is not lost: this describe used to be
 * "user world (not yet implemented)" and pinned a blanket REFUSAL of every
 * `u/` publish and every `u/` read, because Task 4 shipped the namespace
 * before the gate that decides it. Nobody could go live at all. The refusal
 * is not merely deleted — it is replaced, publish by publish, by the
 * allowance that closes the hole, plus the mirror the community world has
 * always had (an `ended` stream is not republishable).
 *
 * The COLLISION PROPERTY the old tests carried is kept, and it now proves the
 * opposite direction: several tests below seed a COMMUNITY event whose stream
 * key is the exact string used in the `u/<key>` path, with NO user stream
 * behind it, and require a refusal. Without that, a user branch that fell
 * through to the `event` table would pass every other test in this file.
 */
describe("AuthoriseStream — user world publish (MediaMTX's own hook)", () => {
  it("ALLOWS a publish under u/ to a LIVE user stream — nobody can go live without this", async () => {
    const stream = await seedUserStream("public");

    const result = await useCase.execute({
      action: "publish",
      path: `u/${stream.streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(true);
  });

  it("allows a publish to a GATED live stream too — visibility gates reading, not publishing", async () => {
    const stream = await seedUserStream("members");

    const result = await useCase.execute({
      action: "publish",
      path: `u/${stream.streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(true);
  });

  /**
   * The mirror of the allowance above, and the exact rule the community world
   * already enforces (`PUBLISHABLE_STATUSES` excludes `ended`): a finished
   * session must not be republishable, because nothing else stops somebody
   * who captured the RTMP URL from restarting it after the creator moved on.
   */
  it("refuses a publish to an ENDED user stream", async () => {
    const stream = await seedUserStream("public");
    await userStreamRepository.endById(stream.id, new Date(NOW));

    const result = await useCase.execute({
      action: "publish",
      path: `u/${stream.streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a publish under u/ against a key no user stream carries", async () => {
    const result = await useCase.execute({
      action: "publish",
      path: "u/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  /** The two worlds do not share a table. A community key is nothing here. */
  it("refuses a publish under u/ naming a COMMUNITY event's stream key", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "scheduled");

    const result = await useCase.execute({
      action: "publish",
      path: `u/${streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  /** ...and the reverse, which nothing pinned before. */
  it("refuses a publish under live/ naming a USER stream's key", async () => {
    const stream = await seedUserStream("public");

    const result = await useCase.execute({
      action: "publish",
      path: `live/${stream.streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses an action under u/ that is neither publish nor read", async () => {
    const stream = await seedUserStream("public");

    for (const action of ["playback", "api", "metrics", "pprof", "", "PUBLISH"]) {
      const result = await useCase.execute({
        action,
        path: `u/${stream.streamKey}`,
        query: "",
        now: NOW,
      });
      expect(result.allowed).toBe(false);
    }
  });
});

/**
 * THE PAYWALL, seen from MediaMTX's own hook (resolution BY KEY).
 *
 * EVERY GATE CASE HERE HAS A TWIN in the by-id describe further down, and
 * vice versa — nine apiece, in the same order: public-no-token,
 * members-no-token, members-with-token, wrong-stream, expired, tampered,
 * wrong-secret, community-token, and unrecognised-visibility. Both describes
 * reach the same `authoriseUserStreamRead`; the pairs exist so that a copy
 * which loosened on ONE path would fail on that path alone and say so.
 *
 * FIX ROUND 1, MIN-4: that claim used to be written here and was FALSE in
 * both directions — this describe had no deny-by-default case at all (so
 * carried requirement #1 rested on a single deletable line in the OTHER
 * describe), and the by-id one had no wrong-secret or community-token case.
 * The three missing twins are added rather than the claim softened, because
 * "the two entry points agree case for case" is the property a shared
 * decision function exists to have.
 *
 * What is deliberately NOT mirrored is each entry point's own RESOLUTION:
 * by-key alone tests that a community event's key resolves to nothing here,
 * and by-id alone tests the publish key, an unknown id, a malformed id and an
 * event id. Those are about which table is consulted and how, which is the
 * one thing the two paths genuinely do differently.
 */
describe("AuthoriseStream — user world read by stream key (MediaMTX's own hook)", () => {
  it("a PUBLIC stream authorises a read with no token at all", async () => {
    const stream = await seedUserStream("public");

    const result = await useCase.execute({
      action: "read",
      path: `u/${stream.streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result).toEqual({ allowed: true });
  });

  it("a MEMBERS stream refuses a read with no token", async () => {
    const stream = await seedUserStream("members");

    const result = await useCase.execute({
      action: "read",
      path: `u/${stream.streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("a MEMBERS stream allows a read with a token minted for it", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", stream.id);

    const result = await useCase.execute({
      action: "read",
      path: `u/${stream.streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: true });
  });

  /**
   * A token proves "this viewer may watch stream X". Without comparing the
   * `streamId` it would prove "this viewer may watch ANY stream" — the same
   * defect class as Phase 6's forwarded media id, and one paid membership
   * anywhere would open every gated broadcast on the platform.
   */
  it("a token minted for ANOTHER stream does not open this one", async () => {
    const target = await seedUserStream("members");
    const other = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", other.id);

    const result = await useCase.execute({
      action: "read",
      path: `u/${target.streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("an EXPIRED token is refused", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor(
      "55555555-5555-4555-8555-555555555555",
      stream.id,
      SECRET,
      NOW - 600_000
    );

    const result = await useCase.execute({
      action: "read",
      path: `u/${stream.streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("a TAMPERED token is refused", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", stream.id);

    const result = await useCase.execute({
      action: "read",
      path: `u/${stream.streamKey}`,
      query: `token=${tamperWith(token)}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("a token signed with the WRONG secret is refused", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", stream.id, OTHER_SECRET);

    const result = await useCase.execute({
      action: "read",
      path: `u/${stream.streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  /**
   * A COMMUNITY watch token is signed with the very same
   * `STREAM_TOKEN_SECRET`. It must not open a user stream, and this is that
   * outcome asserted where a member would feel it — through the real gate,
   * against a real row.
   *
   * FIX ROUND 1, MIN-2 — WHAT REFUSES IT, corrected. This comment used to
   * credit the domain separator in `user-watch-token.ts`. It is not the
   * separator: a community payload carries `subscriptionId`/`eventId` and no
   * `viewerId`, so `verifyUserWatchToken`'s shape checks turn it away whether
   * or not the two worlds share a signing domain, and this test stays green
   * with the separator deleted. The separator is pinned by the one test that
   * genuinely reaches it — `user-watch-token.test.ts > refuses a well-shaped
   * payload signed WITHOUT the domain separator`.
   */
  it("a COMMUNITY watch token does not open a gated user stream", async () => {
    const stream = await seedUserStream("members");
    const community = await seedCommunity();
    const { event } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);

    const result = await useCase.execute({
      action: "read",
      path: `u/${stream.streamKey}`,
      query: `token=${tokenFor(subscription.id, event.id)}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  /**
   * DENY BY DEFAULT, on THIS path too — the twin of the by-id case, and the
   * reason it exists: before fix round 1, carried requirement #1 was pinned
   * by exactly one test on one entry point, so deleting that single line left
   * an allow-by-default paywall with a green suite.
   *
   * The token is present and valid on purpose. It proves the visibility
   * allow-list is consulted BEFORE the token, so no credential can rescue a
   * row whose `visibility` this codebase does not recognise.
   */
  it("DENIES a visibility it does not recognise, even with a valid token", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", stream.id);
    await db
      .update(userStreams)
      .set({ visibility: "tier2" })
      .where(eq(userStreams.id, stream.id));

    const result = await useCase.execute({
      action: "read",
      path: `u/${stream.streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses a read under u/ naming a COMMUNITY event's stream key, token or no token", async () => {
    const community = await seedCommunity();
    const { event, streamKey } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);
    const token = tokenFor(subscription.id, event.id);

    const result = await useCase.execute({
      action: "read",
      path: `u/${streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });
});

/**
 * `authoriseUserReadByStreamId` — Task 4. The user world's answer to the
 * exact problem `authoriseReadByEventId` already solved for the community
 * world, and deliberately the SAME answer rather than a second mechanism.
 *
 * `GET /streams` publishes `/u/<streamId>/index.m3u8` (Task 3,
 * `userStreamPlaybackPath`) — an opaque row id, never the stream key, because
 * a public listing carrying `createSession`'s key-bearing `hlsPlaybackPath`
 * would hand every reader every creator's publish credential. So the READ
 * side must resolve by that id, and hand nginx the key back out of band
 * (`X-Stream-Key`, over loopback) so it can rewrite onto MediaMTX's
 * unchanged `u/<streamKey>` internal path.
 */
describe("AuthoriseStream — user world read by stream id (nginx auth_request)", () => {
  it("authorises a read of a PUBLIC stream named by its stream id, and hands back the key", async () => {
    const stream = await seedUserStream("public");

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: "",
      now: NOW,
    });

    expect(result).toEqual({ allowed: true, streamKey: stream.streamKey });
  });

  /**
   * THE TEST THIS TASK EXISTS FOR. The stream key is the PUBLISH secret; if
   * naming it where an id belongs also opened a read, then publishing ids
   * instead of keys would have bought nothing — the credential would simply
   * be a second, undocumented way in. Mirrors the community world's own
   * "refuses when the caller passes a stream key instead of an event id"
   * above, with a real 32-hex key rather than a token stand-in. TWO
   * independent things refuse it, which is the point: `findById`'s uuid
   * guard turns away a dashless string, and even without that guard the
   * lookup is against the `id` COLUMN, which no stream key ever occupies.
   */
  it("refuses a read naming the publish KEY instead of the stream id", async () => {
    const stream = await seedUserStream("public");

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.streamKey,
      query: "",
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  /**
   * THE SAME PAYWALL AS THE BY-KEY DESCRIBE ABOVE, asserted through the OTHER
   * entry point — because nginx's `auth_request` is the one a member's browser
   * actually reaches, and MediaMTX's own hook is the one a client reaches
   * directly. Task 5's ruling: ONE decision function, TWO callers. These five
   * tests are what would redden if somebody copied the gate into one path and
   * then loosened only that copy.
   *
   * This block REPLACES the Task 4 test that pinned "a MEMBERS-only stream
   * refuses outright — the gate itself arrives in Task 5". The gate has
   * arrived; the blanket refusal it stood in for is now the no-token case
   * immediately below.
   */
  it("a MEMBERS stream refuses a read with no token", async () => {
    const stream = await seedUserStream("members");

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: "",
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("a MEMBERS stream allows a read with a token minted for it, and hands back the key", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", stream.id);

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: true, streamKey: stream.streamKey });
  });

  it("a token minted for ANOTHER stream does not open this one", async () => {
    const target = await seedUserStream("members");
    const other = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", other.id);

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: target.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("an EXPIRED token is refused", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor(
      "55555555-5555-4555-8555-555555555555",
      stream.id,
      SECRET,
      NOW - 600_000
    );

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("a TAMPERED token is refused", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", stream.id);

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: `token=${tamperWith(token)}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("a token signed with the WRONG secret is refused", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", stream.id, OTHER_SECRET);

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  /**
   * The twin of the by-key case, and the one that matters most on THIS path:
   * nginx's `auth_request` is what a member's browser actually reaches, so a
   * community token opening a user stream here would be the bypass a real
   * person could perform. Refused by `verifyUserWatchToken`'s shape checks —
   * see the by-key twin's comment for why that, and not the domain
   * separator, is what turns it away.
   */
  it("a COMMUNITY watch token does not open a gated user stream", async () => {
    const stream = await seedUserStream("members");
    const community = await seedCommunity();
    const { event } = await seedEvent(community.id, "live");
    const subscription = await seedActiveSubscription(community.id);

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: `token=${tokenFor(subscription.id, event.id)}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  /**
   * A stream whose `visibility` this codebase does not recognise — a typo, a
   * future tier name — must DENY, not sail through. `toStreamView`'s own
   * gate reads the other way round (`=== MEMBERS_ONLY` locks, anything else
   * is open), which is safe there only because the write path is the
   * authority on what may be stored. It is NOT safe here: this method is the
   * paywall itself, and an allow-by-default paywall is one typo from open.
   */
  it("DENIES a visibility it does not recognise, rather than treating it as public", async () => {
    const stream = await seedUserStream("members");
    await db
      .update(userStreams)
      .set({ visibility: "publik" })
      .where(eq(userStreams.id, stream.id));

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: "",
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("refuses a stream id that names no row at all", async () => {
    const result = await useCase.authoriseUserReadByStreamId({
      streamId: "00000000-0000-4000-8000-000000000000",
      query: "",
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  /**
   * nginx captures this value straight out of the PUBLIC request URI, so a
   * stranger fetching `/u/anything-at-all/index.m3u8` decides what arrives
   * here. A malformed id must be a REFUSAL, not a driver error that becomes
   * a 500 — the same rule `EventRepositoryPort.findById` already documents.
   */
  it("refuses a malformed stream id rather than failing with a driver error", async () => {
    const result = await useCase.authoriseUserReadByStreamId({
      streamId: "../../etc/passwd",
      query: "",
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  /**
   * The two worlds share nothing but a webhook. An event id resolves in the
   * `event` table and must mean nothing here, exactly as a user stream id
   * means nothing to `authoriseReadByEventId`.
   */
  it("refuses a community EVENT id — the two worlds do not share a lookup", async () => {
    const community = await seedCommunity();
    const { event } = await seedEvent(community.id, "live");

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: event.id,
      query: "",
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });
});

/**
 * **I3 (final whole-branch review). *Akhiri siaran* has to mean something on
 * the read side too.**
 *
 * `EndOwnUserStream` marks the row `ended` and nothing kicks the publisher —
 * MediaMTX authorises a publish once, at connect, and is not polled — so an
 * OBS publisher that is already connected keeps sending. That half is out of
 * scope and disclosed. What IS in scope is that the read gate used to have no
 * status check at all, so a member holding the stream id could keep
 * re-minting a fresh ten-minute token and keep watching a broadcast the
 * creator believes they ended, indefinitely.
 *
 * **EVERY TEST HERE MINTS A VALID TOKEN FIRST, deliberately** — the same
 * property the visibility allow-list's own tests carry, and for the same
 * reason. A gated ended stream with no token would be refused by the
 * missing-token guard and would never reach the status check in its own name.
 * The public cases need no token by construction: a public stream authorises
 * a read with none at all, so the ONLY thing that can refuse one is the
 * status check.
 *
 * Both entry points, because there are two of them and one shared decision —
 * this is exactly the pair that would drift if the check were added to one.
 */
describe("AuthoriseStream — an ENDED user stream refuses every read", () => {
  /** Ends the row through the same atomic `endById` all three enders funnel into. */
  async function end(streamId: string) {
    const ended = await userStreamRepository.endById(streamId, new Date(NOW));
    expect(ended?.status).toBe("ended");
  }

  it("by KEY: a PUBLIC stream that ENDED refuses a read that would have been allowed while live", async () => {
    const stream = await seedUserStream("public");
    // The positive control, on the very same row: while live, this exact
    // call is allowed with no token at all.
    expect(
      await useCase.execute({ action: "read", path: `u/${stream.streamKey}`, query: "", now: NOW })
    ).toEqual({ allowed: true });

    await end(stream.id);

    const result = await useCase.execute({
      action: "read",
      path: `u/${stream.streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("by KEY: a MEMBERS stream that ENDED refuses a read even with a VALID, unexpired token", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", stream.id);
    await end(stream.id);

    const result = await useCase.execute({
      action: "read",
      path: `u/${stream.streamKey}`,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("by ID: a PUBLIC stream that ENDED refuses, and hands back no stream key", async () => {
    const stream = await seedUserStream("public");
    expect(
      await useCase.authoriseUserReadByStreamId({ streamId: stream.id, query: "", now: NOW })
    ).toEqual({ allowed: true, streamKey: stream.streamKey });

    await end(stream.id);

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: "",
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });

  it("by ID: a MEMBERS stream that ENDED refuses a read even with a VALID, unexpired token", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", stream.id);
    await end(stream.id);

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: `token=${token}`,
      now: NOW,
    });

    expect(result).toEqual({ allowed: false });
  });
});

describe("AuthoriseStream — unrecognised actions", () => {
  it("refuses an action that is neither publish nor read", async () => {
    const community = await seedCommunity();
    const { streamKey } = await seedEvent(community.id, "live");

    for (const action of ["playback", "api", "metrics", "pprof", "", "PUBLISH"]) {
      const result = await useCase.execute({ action, path: `live/${streamKey}`, query: "", now: NOW });
      expect(result.allowed).toBe(false);
    }
  });
});
