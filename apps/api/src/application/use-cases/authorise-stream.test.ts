import { describe, expect, it, beforeEach } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { appUsers, userStreams } from "../../db/schema";
import { resetDatabase } from "../../db/test-helpers";
import { DrizzleUserStreamRepository } from "../../infrastructure/repositories/drizzle-user-stream.repository";
import {
  mintUserWatchToken,
  USER_WATCH_TOKEN_TTL_MS,
} from "../../domain/user-watch-token";
import { AuthoriseStream, parseStreamPath } from "./authorise-stream";

beforeEach(resetDatabase);

const SECRET = "a".repeat(32);
const OTHER_SECRET = "b".repeat(32);
const NOW = Date.parse("2026-08-11T10:00:00.000Z");

const userStreamRepository = new DrizzleUserStreamRepository(db);
const useCase = new AuthoriseStream(userStreamRepository, { streamTokenSecret: SECRET });

let seedCounter = 0;

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

/**
 * A COMMUNITY watch token, of the retired `domain/watch-token.ts` shape —
 * built here, by hand, because Phase 8 Task 6 deleted that module.
 *
 * REPAIRED, NOT DELETED. Two tests below (one per read entry point) pin that a
 * community token does not open a gated user stream. Both used to call
 * `mintWatchToken`. The property outlived the module: `STREAM_TOKEN_SECRET` is
 * still the one signing secret, the wire format is still
 * `<base64url payload>.<HMAC>`, and a token of this shape is still something a
 * leaked secret or an old deploy can produce. So the deleted module's formula
 * is written out here instead — a BARE-payload HMAC (no domain separator, the
 * separator being `user-watch-token.ts`'s alone) over a
 * `{ subscriptionId, eventId, exp }` payload, six-hour expiry. That
 * duplication IS the assertion, exactly as it is in
 * `user-watch-token.test.ts`'s own two hand-built cases.
 *
 * `streamId` is passed as `eventId` deliberately: the token names the very row
 * being requested, so the `claims.streamId !== stream.id` comparison cannot be
 * what refuses it. Only the token's KIND can.
 */
function communityWatchToken(streamId: string, secret = SECRET, now = NOW) {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const encoded = Buffer.from(
    JSON.stringify({
      subscriptionId: "00000000-0000-4000-8000-000000000000",
      eventId: streamId,
      exp: now + SIX_HOURS_MS,
    })
  ).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
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
 * `parseStreamPath` is the ONE parser `AuthoriseStream.execute` and
 * `POST /webhooks/mediamtx/lifecycle` both go through — see its own docstring
 * for why a second, looser parser would re-open the exact defect
 * `streamKeyFromPath` was hardened against (a publish to `foo/bar/<key>` once
 * authorising exactly as `live/<key>` did).
 *
 * PHASE 8, TASK 6 — ONE NAMESPACE LEFT, AND IT IS STILL AN ALLOW-LIST. With
 * `live/` gone there is exactly one entry in `NAMESPACES`, and the tempting
 * simplification is "any two-segment path is a user stream". These four
 * refusal cases are what makes that mutation fail: a lookup that can MISS is
 * the whole mechanism, and a map with one key still has to be consulted.
 * Verified by mutation — see this task's report.
 */
describe("parseStreamPath", () => {
  it("u/<key> is the user world", () => {
    expect(parseStreamPath("u/abc123")).toEqual({ world: "user", key: "abc123" });
  });

  it("live/<key> is no longer a namespace — refused, not resolved", () => {
    expect(parseStreamPath("live/abc123")).toBeNull();
  });

  it("an unknown namespace is still refused, never assumed to be the surviving one", () => {
    expect(parseStreamPath("foo/abc123")).toBeNull();
  });

  it("a three-segment path is refused even when its first segment is known", () => {
    expect(parseStreamPath("u/abc123/extra")).toBeNull();
  });

  it("a bare key with no namespace is refused", () => {
    expect(parseStreamPath("abc123")).toBeNull();
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
 * PHASE 8, TASK 6 — WHAT THE CROSSOVER TESTS BECAME. Several tests here used
 * to seed a COMMUNITY event whose stream key was the exact string used in the
 * `u/<key>` path, with no user stream behind it, so that a user branch falling
 * through to the `event` table would be caught. That table has no reader left
 * in this file to fall through TO, so those cases collapsed into "refuses a
 * publish under u/ against a key no user stream carries". What replaced them
 * is the pair below that drives `execute()` through a RETIRED and an UNKNOWN
 * namespace with a real, publishable key — the property that actually needs
 * defending now that the allow-list has one entry.
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
   * The mirror of the allowance above: a finished session must not be
   * republishable, because nothing else stops somebody who captured the RTMP
   * URL from restarting it after the creator moved on. The retired community
   * world enforced the identical rule, and it did not leave with it.
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

  /**
   * THE ALLOW-LIST, ASSERTED THROUGH `execute()` RATHER THAN THE PARSER —
   * Phase 8, Task 6, and the reason both halves are here rather than one.
   *
   * `parseStreamPath`'s own describe proves the PARSER refuses a namespace it
   * does not know. These two prove the AUTHORISER does: the key is a real,
   * live, publishable user stream's key, so the ONLY thing standing between
   * each path and `{ allowed: true }` is the namespace lookup. A `parseStreamPath`
   * that returned `{ world: "user", key }` for any two-segment path would make
   * both of these authorise a publish to a path no adapter in this codebase
   * ever constructs — which is the defect, verbatim, that the parser's
   * docstring records.
   *
   * `live/` is named explicitly because it is the one namespace that USED to
   * work. A deployment still pointing at it must be refused, not quietly
   * served as if it had said `u/`.
   */
  it("refuses a publish under the RETIRED live/ namespace, even with a real user stream's key", async () => {
    const stream = await seedUserStream("public");

    const result = await useCase.execute({
      action: "publish",
      path: `live/${stream.streamKey}`,
      query: "",
      now: NOW,
    });

    expect(result.allowed).toBe(false);
  });

  it("refuses a publish under an UNKNOWN namespace, even with a real user stream's key", async () => {
    const stream = await seedUserStream("public");

    const result = await useCase.execute({
      action: "publish",
      path: `foo/${stream.streamKey}`,
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
 * by-key alone tests a key no row carries, and by-id alone tests the publish
 * key, an unknown id and a malformed id. Those are about WHICH COLUMN is
 * consulted and how, which is the one thing the two paths genuinely do
 * differently.
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
   * against a real row. Phase 8 deleted the module that minted these; see
   * `communityWatchToken` at the top of this file for why the property
   * outlived it and how the token is built now.
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

    const result = await useCase.execute({
      action: "read",
      path: `u/${stream.streamKey}`,
      query: `token=${communityWatchToken(stream.id)}`,
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
});

/**
 * `authoriseUserReadByStreamId` — the entry point nginx's `auth_request`
 * calls. It is the same answer the retired community world eventually reached
 * for the identical problem, rather than a second mechanism beside it.
 *
 * `GET /streams` publishes `/u/<streamId>/index.m3u8`
 * (`userStreamPlaybackPath`) — an opaque row id, never the stream key,
 * because a public listing carrying a key-bearing playback URL would hand
 * every reader every creator's publish credential. So the READ side must
 * resolve by that id, and hand nginx the key back out of band
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
   * be a second, undocumented way in. The retired community world carried the
   * same case ("refuses when the caller passes a stream key instead of an event id")
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

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: `token=${communityWatchToken(stream.id)}`,
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
   *
   * **M1 (final whole-branch review): this test used to pass for the wrong
   * reason.** It called `authoriseUserReadByStreamId` with `query: ""`, so
   * the refusal came from the `watchTokenFromQuery` → `!token` guard and
   * never reached the visibility allow-list this test is named for —
   * deleting `if (stream.visibility !== MEMBERS_ONLY) return { allowed:
   * false }` left it GREEN, and only its by-key sibling (whose own docstring
   * says "the token is present and valid on purpose") reddened. The by-id
   * copy had lost that property. It now sends a VALID, unexpired token minted
   * for this very row, so the ONLY thing left that can refuse is the
   * allow-list.
   */
  it("DENIES a visibility it does not recognise, rather than treating it as public", async () => {
    const stream = await seedUserStream("members");
    const token = userTokenFor("55555555-5555-4555-8555-555555555555", stream.id);
    await db
      .update(userStreams)
      .set({ visibility: "publik" })
      .where(eq(userStreams.id, stream.id));

    const result = await useCase.authoriseUserReadByStreamId({
      streamId: stream.id,
      query: `token=${token}`,
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
   * a 500 — the same rule `UserStreamRepositoryPort.findById` documents.
   */
  it("refuses a malformed stream id rather than failing with a driver error", async () => {
    const result = await useCase.authoriseUserReadByStreamId({
      streamId: "../../etc/passwd",
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

// The "unrecognised actions" describe that used to sit here drove its loop
// over a COMMUNITY `live/<key>` path, so with that namespace retired it would
// have proved only that `parseStreamPath` refuses — not that an unknown ACTION
// does. The property is not lost: "refuses an action under u/ that is neither
// publish nor read" (in the publish describe above) runs the identical loop
// against a real, live user stream, which is the only path that reaches the
// action check at all.
