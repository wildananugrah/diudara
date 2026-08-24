import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../app";
import { bootstrap, selectMediaStorage, selectPaymentProvider } from "../bootstrap";
import { db } from "../db/client";
import {
  appUsers,
  outbox,
  postMedia,
  userStreams,
  userSubscriptions,
  userTiers,
  userTransactions,
  webhookEvents,
} from "../db/schema";
import { resetDatabase } from "../db/test-helpers";
import { FakeEmailAdapter } from "../infrastructure/email/fake-email.adapter";
import { FakeMessagingAdapter } from "../infrastructure/messaging/fake-messaging.adapter";
import { FakePaymentAdapter } from "../infrastructure/payments/fake-payment.adapter";
import { DrizzleMediaRepository } from "../infrastructure/repositories/drizzle-media.repository";
import { DrizzleOutboxRepository } from "../infrastructure/repositories/drizzle-outbox.repository";
import { DrizzleUserStreamRepository } from "../infrastructure/repositories/drizzle-user-stream.repository";
import { DrizzleUserSubscriptionRepository } from "../infrastructure/repositories/drizzle-user-subscription.repository";
import { bootstrapWorker } from "../worker-bootstrap";
// The worker's own passes, imported ACROSS the workspace boundary on purpose —
// see the `FLOW 4` docstring for why a re-implementation here would test nothing.
import {
  SweepExpiredMemberships,
  SweepOrphanMedia,
  SweepStalePendingCheckouts,
  SweepStaleUserStreams,
} from "../../../worker/src/scheduled-passes";

/**
 * THE FOUR FLOWS THE DELETION COULD HAVE BROKEN — retire-telegram, Task 8.
 *
 * Phase 8 added nothing. It deleted the dashboard SPA, Telegram, the old
 * streaming world, the old API, and both halves of two files that served both
 * worlds; the api suite fell from 2820 tests to 1594. Every one of those
 * deletions was proved from its own diff, and every surviving test still
 * passes — and that is exactly the risk this file exists for. A deletion phase
 * can leave every remaining test green while a FLOW is broken at a seam nobody
 * exercises end to end, because each task only ever proved its own piece.
 *
 * So these are a NET, not a red-green cycle: they were written against the
 * finished branch and were expected to pass on their first run. A failure here
 * is a report about a broken seam, never a test to be adjusted until it
 * passes.
 *
 * Each test walks a whole path through what survived, against the REAL
 * database and through the REAL routes — nothing is mocked except the outbound
 * adapters the whole suite already fakes (payments, email, WhatsApp, object
 * storage), which `bootstrap()` selects on its own under `NODE_ENV=test`.
 *
 * WHAT EACH ONE CROSSES, and what breaking that seam would cost:
 *
 *  1. THE MEMBERSHIP GATE — `status = 'active' AND current_period_end > now`.
 *     Break it and either every stranger sees paid content or no member does.
 *
 *     THERE ARE TWO IMPLEMENTATIONS OF THAT PREDICATE AND THEY ARE REACHED BY
 *     DIFFERENT FLOWS, which is worth stating here because it is easy to
 *     assume otherwise. `is-member-of.ts` answers a per-PAIR question and is
 *     asked by the public profile and by `MintUserWatchToken` (FLOW 3);
 *     `listActiveOwnersAmong` answers it for a whole feed page, and is what
 *     the post paywall's two barriers — the projection in `read-posts.ts` and
 *     `MediaEntitlement` at the delivery route — both ask (FLOW 1). The
 *     duplication is deliberate and documented at both ends (`is-member-of.ts`
 *     is untouchable by every plan since 5a), so the two flows below cross the
 *     two implementations separately and neither one stands in for the other.
 *  2. `routeInvoiceExternalId`'s `usub_` namespace — the money path. Break it
 *     and a member pays and is never activated.
 *  3. `parseStreamPath`'s allow-list — every publish and every read. Break it
 *     and nobody can go live, or anybody can.
 *  4. The worker's composition — six passes on two cadences. Break one and it
 *     is dead code that nothing notices, which is the state Phase 5's Task 7
 *     found `ProcessRenewals` in.
 *
 * DELIBERATE OVERLAP WITH THE UNIT AND ROUTE SUITES. Every assertion below has
 * a narrower test somewhere that covers the same rule in more detail. That is
 * not duplication to be trimmed: those tests each stand at one layer, and what
 * has never been pinned is that the layers still JOIN — that the token minted
 * by the route is the token nginx's entry point accepts, that the `external_id`
 * checkout wrote is the one the webhook routes, that the pass the worker
 * constructs is the pass that moves a real row.
 */

beforeEach(resetDatabase);

const CALLBACK_TOKEN = process.env.XENDIT_CALLBACK_TOKEN ?? "test-callback-token";

/** The `X-Mediamtx-Secret` value for FLOW 3, at the 32-character floor `bootstrap()` enforces. */
const STREAM_SECRET = "f".repeat(32);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function app() {
  return createApp(bootstrap());
}

function authed(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

interface Account {
  handle: string;
  email: string;
  password: string;
  displayName: string;
}

function account(handle: string): Account {
  return {
    handle,
    email: `${handle}@example.com`,
    password: "supersecret123",
    displayName: handle,
  };
}

/**
 * Signs up and then logs in, returning the bearer token and the new user's id.
 * Two calls because `POST /users/signup` deliberately answers `{ ok: true }`
 * and nothing else — the same helper `routes/streams.test.ts` and
 * `routes/posts.test.ts` each keep locally, written locally again here because
 * no test file in this codebase imports helpers from another.
 */
async function signUp(a: ReturnType<typeof app>, who: Account) {
  const signup = await a.request("/users/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(who),
  });
  expect(signup.status).toBe(201);
  const login = await a.request("/users/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: who.email, password: who.password }),
  });
  expect(login.status).toBe(200);
  const body = await login.json();
  return { token: body.token as string, userId: body.user.id as string, handle: who.handle };
}

/**
 * A real membership row from `subscriberId` to `ownerId`, ending at
 * `periodEnd`. Written directly rather than bought, because the READ side is
 * what these flows are crossing and FLOW 2 is where the purchase itself is
 * walked; a tier comes first because `user_subscription_tier_owner_fk` makes a
 * subscription whose owner disagrees with its tier's owner impossible to
 * insert.
 *
 * `periodEnd` in the PAST with `status = 'active'` is the LAPSED state — not
 * an invalid row, but the one spec §9 guarantees every paying member reaches,
 * since nothing renews. It is the reader `IsMemberOf` must answer "no" for.
 */
async function grantMembership(subscriberId: string, ownerId: string, periodEnd: Date) {
  const [tier] = await db
    .insert(userTiers)
    .values({ ownerId, name: "Anggota", priceAmount: 50_000, billingCycle: "monthly" })
    .returning();
  await db.insert(userSubscriptions).values({
    subscriberId,
    tierId: tier!.id,
    ownerId,
    status: "active",
    currentPeriodEnd: periodEnd,
  });
}

/** Uploads `small.png` through the real `POST /users/media` and returns the new media id. */
async function uploadFixture(a: ReturnType<typeof app>, token: string): Promise<string> {
  const bytes = await Bun.file(`${import.meta.dir}/../test-support/fixtures/small.png`).bytes();
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), "small.png");

  const res = await a.request("/users/media", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  expect(res.status).toBe(201);
  return (await res.json()).id as string;
}

/** The posts on a profile, read as whoever `token` names — or as nobody when it is absent. */
async function profilePosts(a: ReturnType<typeof app>, handle: string, token?: string) {
  const res = await a.request(
    `/users/${handle}/posts`,
    token ? { headers: authed(token) } : undefined
  );
  expect(res.status).toBe(200);
  return (await res.json()).posts as {
    id: string;
    body: string;
    media: { id: string }[];
    membersOnly: boolean;
    lockedMediaCount: number;
  }[];
}

/**
 * FLOW 1 — A GATED POST REACHES A MEMBER AND NOT A STRANGER.
 *
 * Compose it through `POST /users/posts` with `visibility: "members"` (which
 * is why the image is uploaded first: Task 5 of Phase 6 made at least one
 * image a server-side requirement for a gated post), then read the SAME post
 * back four ways through `GET /users/:handle/posts`.
 *
 * THE FOUR READERS ARE THE POINT, and the gate they cross is
 * `listActiveOwnersAmong` — the post paywall's own copy of the predicate, NOT
 * `is-member-of.ts` (see this file's header for why there are two and which
 * flow reaches which):
 *
 *  - the OWNER never asks it at all — the author always gets their own media;
 *  - the PAYING MEMBER passes both halves — `status = 'active'` AND
 *    `current_period_end > now`;
 *  - the LAPSED member passes only the first: an `active` row whose paid
 *    period has passed, the state spec §9 guarantees every member reaches
 *    since nothing renews, and the one a status-only check would read as a
 *    member FOREVER;
 *  - the SIGNED-OUT stranger never reaches the gate at all, and must get the
 *    caption with no media.
 *
 * Three of those four would still pass if the gate answered a constant, which
 * is why all four are here: the member and the lapsed member differ ONLY
 * because the `current_period_end` comparison exists, so that pair is the
 * whole assertion and either one alone is decorative.
 *
 * BOTH BARRIERS, because neither is sufficient alone and each has to hold with
 * the other disabled (spec §6.2). Barrier one is the projection: a locked
 * response must not carry the media id ANYWHERE, under any key — checked
 * against the raw response TEXT, because a spot-check on `media` alone passes
 * against a body that leaked the id somewhere else. Barrier two is the
 * delivery route, asked with the id in hand, which is what makes a member's
 * forwarded link fail for the person they forwarded it to.
 */
test("FLOW: a gated post reaches a member and not a stranger", async () => {
  const a = app();
  const rina = await signUp(a, account("rina"));
  const andi = await signUp(a, account("andi"));
  const siti = await signUp(a, account("siti"));

  const mediaId = await uploadFixture(a, rina.token);
  const created = await a.request("/users/posts", {
    method: "POST",
    headers: authed(rina.token),
    body: JSON.stringify({
      body: "Khusus anggota",
      mediaIds: [mediaId],
      visibility: "members",
    }),
  });
  expect(created.status).toBe(201);
  const post = await created.json();
  expect(post.membersOnly).toBe(true);

  // Andi pays; Siti paid once and her period ran out yesterday.
  await grantMembership(andi.userId, rina.userId, new Date(Date.now() + 30 * DAY_MS));
  await grantMembership(siti.userId, rina.userId, new Date(Date.now() - DAY_MS));

  const [asOwner] = await profilePosts(a, "rina", rina.token);
  expect(asOwner.media.map((image) => image.id)).toEqual([mediaId]);
  expect(asOwner.lockedMediaCount).toBe(0);

  const [asMember] = await profilePosts(a, "rina", andi.token);
  expect(asMember.media.map((image) => image.id)).toEqual([mediaId]);
  expect(asMember.lockedMediaCount).toBe(0);

  const [asLapsed] = await profilePosts(a, "rina", siti.token);
  expect(asLapsed.body).toBe("Khusus anggota");
  expect(asLapsed.media).toEqual([]);
  expect(asLapsed.membersOnly).toBe(true);
  expect(asLapsed.lockedMediaCount).toBe(1);

  const [asStranger] = await profilePosts(a, "rina");
  expect(asStranger.body).toBe("Khusus anggota");
  expect(asStranger.media).toEqual([]);
  expect(asStranger.lockedMediaCount).toBe(1);

  // The media id must not survive anywhere in a locked body — not under
  // `media`, and not under any other key either.
  const strangerText = await (await a.request("/users/rina/posts")).text();
  expect(strangerText).not.toContain(mediaId);
  const feedText = await (await a.request("/users/feed?tab=untuk-anda")).text();
  expect(feedText).not.toContain(mediaId);

  // BARRIER TWO, with the id in hand. The projection above is not a paywall on
  // its own — a paying member holds legitimate ids and can forward one — so the
  // delivery route must refuse the same four readers the same way, and a
  // refusal there is a 404 rather than a 403.
  const bytes = (token?: string) =>
    a.request(`/users/media/${mediaId}`, token ? { headers: authed(token) } : undefined);
  expect((await bytes(rina.token)).status).toBe(200);
  expect((await bytes(andi.token)).status).toBe(200);
  expect((await bytes(siti.token)).status).toBe(404);
  expect((await bytes()).status).toBe(404);
});

/**
 * FLOW 2 — A MEMBERSHIP CAN BE BOUGHT AND ACTIVATES ON ITS WEBHOOK.
 *
 * The whole money path, in the order a real purchase runs it: the creator
 * connects a payout account and publishes a tier, the buyer subscribes, and
 * Xendit calls back.
 *
 * THE NAMESPACE IS ASSERTED AS A WIRE LITERAL. `usub_` is what
 * `routeInvoiceExternalId` matches on, and the reason it still exists after
 * the community half of the handler was deleted is that it is what lets this
 * ONE PUBLIC endpoint answer "this invoice is not ours at all". Asserting the
 * literal rather than importing the prefix is the rule this repository
 * follows: a test that imports the constant it checks passes after somebody
 * renames the namespace and every live invoice stops routing.
 *
 * THE INVOICE ID COMES OUT OF THE COLUMN, never invented. `body.id` is
 * verified against `user_transaction.gateway_reference_id`, so a delivery
 * carrying anything else is refused — which is the defence that turned 12
 * concurrent forged deliveries into 12 rejections.
 *
 * AND THE REPLAY. Xendit's callback token authenticates the SENDER, not the
 * message, and carries no nonce — so `webhook_event.provider_event_id` UNIQUE
 * is the entire replay defence. The second, byte-identical delivery must
 * change NOTHING: not the period the member paid for, not `paid_at`, and not
 * the number of recorded events.
 */
test("FLOW: a membership can be bought and activates on its webhook", async () => {
  const a = app();
  const rina = await signUp(a, account("rina"));
  const andi = await signUp(a, account("andi"));

  expect(
    (await a.request("/users/me/payout", { method: "POST", headers: authed(rina.token) })).status
  ).toBe(200);

  const tierRes = await a.request("/users/me/tiers", {
    method: "POST",
    headers: authed(rina.token),
    body: JSON.stringify({ name: "Anggota", priceAmount: 50_000 }),
  });
  expect(tierRes.status).toBe(201);
  const tier = await tierRes.json();

  const boughtRes = await a.request("/users/rina/subscribe", {
    method: "POST",
    headers: authed(andi.token),
    body: JSON.stringify({ tierId: tier.id }),
  });
  expect(boughtRes.status).toBe(201);
  const bought = await boughtRes.json();

  // The namespace, as it goes on the wire.
  expect(bought.externalId.startsWith("usub_")).toBe(true);

  const [pending] = await db
    .select()
    .from(userSubscriptions)
    .where(eq(userSubscriptions.id, bought.subscriptionId));
  expect(pending.status).toBe("pending");
  expect(pending.currentPeriodEnd).toBeNull();

  const [transaction] = await db
    .select()
    .from(userTransactions)
    .where(eq(userTransactions.id, bought.transactionId));
  expect(transaction.status).toBe("pending");
  const invoiceId = transaction.gatewayReferenceId!;

  // A gated post, composed BEFORE the money lands, so the same reader can be
  // asked the same question either side of the callback.
  const gatedMediaId = await uploadFixture(a, rina.token);
  expect(
    (
      await a.request("/users/posts", {
        method: "POST",
        headers: authed(rina.token),
        body: JSON.stringify({
          body: "Khusus anggota",
          mediaIds: [gatedMediaId],
          visibility: "members",
        }),
      })
    ).status
  ).toBe(201);
  const [beforePurchase] = await profilePosts(a, "rina", andi.token);
  expect(beforePurchase.media).toEqual([]);
  expect(beforePurchase.lockedMediaCount).toBe(1);

  const delivery = {
    id: invoiceId,
    external_id: bought.externalId,
    status: "PAID",
    amount: 50_000,
  };
  const callback = () =>
    a.request("/webhooks/xendit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CALLBACK-TOKEN": CALLBACK_TOKEN },
      body: JSON.stringify(delivery),
    });

  expect((await callback()).status).toBe(200);

  const [activated] = await db
    .select()
    .from(userSubscriptions)
    .where(eq(userSubscriptions.id, bought.subscriptionId));
  expect(activated.status).toBe("active");
  expect(activated.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());

  const [settled] = await db
    .select()
    .from(userTransactions)
    .where(eq(userTransactions.id, bought.transactionId));
  expect(settled.status).toBe("paid");
  expect(settled.paidAt).not.toBeNull();

  const recorded = await db.select().from(webhookEvents);
  expect(recorded).toHaveLength(1);
  expect(recorded[0].provider).toBe("xendit");
  expect(recorded[0].eventType).toBe("invoice.paid");

  // AND THE PURCHASE JOINS UP WITH THE GATE. Nothing on either side of that
  // seam states it: `HandlePaymentWebhook`'s tests end at the row, and the
  // paywall's tests start from a row somebody inserted. The buyer was locked
  // out of this exact post before the callback and must be inside it after,
  // and the only thing that changed is what the webhook wrote.
  const [afterPurchase] = await profilePosts(a, "rina", andi.token);
  expect(afterPurchase.media.map((image) => image.id)).toEqual([gatedMediaId]);
  expect(afterPurchase.lockedMediaCount).toBe(0);

  // THE REPLAY. Byte-identical, and it must change nothing at all.
  expect((await callback()).status).toBe(200);

  const [replayed] = await db
    .select()
    .from(userSubscriptions)
    .where(eq(userSubscriptions.id, bought.subscriptionId));
  expect(replayed.status).toBe("active");
  expect(replayed.currentPeriodEnd!.toISOString()).toBe(activated.currentPeriodEnd!.toISOString());

  const [replayedTransaction] = await db
    .select()
    .from(userTransactions)
    .where(eq(userTransactions.id, bought.transactionId));
  expect(replayedTransaction.paidAt!.toISOString()).toBe(settled.paidAt!.toISOString());

  expect(await db.select().from(webhookEvents)).toHaveLength(1);
});

/**
 * Runs `fn` with live streaming fully configured, restoring every variable
 * afterwards — including the ones the test preload deliberately deleted for
 * the whole run (see `test-env-preload.ts`, which is why a bare `bootstrap()`
 * has no `authoriseStream` and no `mintUserWatchToken`).
 *
 * `bootstrap()` MUST be called INSIDE the callback: the secrets are read at
 * construction time, not per request.
 */
async function withStreamingConfigured<T>(fn: () => Promise<T>): Promise<T> {
  const keys = [
    "MEDIAMTX_RTMP_HOST",
    "MEDIAMTX_HLS_BASE_URL",
    "MEDIAMTX_WHIP_BASE_URL",
    "MEDIAMTX_WEBHOOK_SECRET",
    "STREAM_TOKEN_SECRET",
  ] as const;
  const originals = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.MEDIAMTX_RTMP_HOST = "mediamtx.internal";
  process.env.MEDIAMTX_HLS_BASE_URL = "https://hls.diudara.test";
  process.env.MEDIAMTX_WHIP_BASE_URL = "https://whip.diudara.test";
  process.env.MEDIAMTX_WEBHOOK_SECRET = STREAM_SECRET;
  process.env.STREAM_TOKEN_SECRET = STREAM_SECRET;
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      const value = originals[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * FLOW 3 — A CREATOR GOES LIVE, A MEMBER WATCHES, THE STREAM ENDS.
 *
 * The one path with three different callers on it, and after Phase 8 they all
 * meet at one function. `parseStreamPath` used to hold two namespaces and now
 * holds `u` alone; `AuthoriseStream` used to have a second read entry point
 * resolved by event id; `/lifecycle` used to dispatch to one of two classes.
 * Everything below crosses what is left of that, in order:
 *
 *  1. `POST /streams` — the row, the key, and both publish URLs.
 *  2. `POST /webhooks/mediamtx/auth` with `action: "publish"` — MediaMTX's own
 *     `authHTTPAddress` hook, asked about the path our adapter constructs.
 *  3. `POST /streams/:id/watch-token` — the MINT, which is where the
 *     entitlement check lives for a `members` stream (the read side
 *     deliberately does not re-check, design spec §5). A non-member is refused
 *     here, and that refusal is `IsMemberOf` again, reached by a completely
 *     different route than FLOW 1's.
 *  4. `GET /webhooks/mediamtx/auth-request` — nginx's `auth_request`, by
 *     STREAM ID, with the minted token in `X-Watch-Token`. The stream key comes
 *     back in a HEADER and must never appear in the body: the member-facing URL
 *     must not be the publish credential.
 *  5. `POST /webhooks/mediamtx/lifecycle` — `runOnOffline`, with the
 *     `$MTX_PATH` MediaMTX actually hands the hook.
 *
 * TWO REFUSALS ARE PART OF THE FLOW, not extras. After the stream ends, the
 * same publish that was authorised in step 2 must now be refused — nothing else
 * stops somebody who captured the RTMP URL from restarting the broadcast. And a
 * `live/<key>` hook from a stale deployment must 404 rather than be treated as
 * the one world left: that is the allow-list staying an allow-list, and it is
 * the half of `parseStreamPath` that a LOOSENED parser would break while every
 * `u/<key>` step above went on passing.
 */
test("FLOW: a creator goes live, a member watches, the stream ends", async () => {
  await withStreamingConfigured(async () => {
    const a = app();
    const rina = await signUp(a, account("rina"));
    const budi = await signUp(a, account("budi"));

    const startedRes = await a.request("/streams", {
      method: "POST",
      headers: authed(rina.token),
      body: JSON.stringify({ title: "Tanya jawab", visibility: "members" }),
    });
    expect(startedRes.status).toBe(201);
    const stream = await startedRes.json();
    expect(stream.visibility).toBe("members");
    expect(stream.rtmpUrl).toContain("rtmp://mediamtx.internal");

    const mediamtx = (path: string, body: unknown) =>
      a.request(`/webhooks/mediamtx/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Mediamtx-Secret": STREAM_SECRET },
        body: JSON.stringify(body),
      });

    // 2. MediaMTX asks whether this publish may go ahead, naming the path our
    //    own adapter told the creator to publish to.
    const publish = await mediamtx("auth", {
      action: "publish",
      path: `u/${stream.streamKey}`,
      query: "",
    });
    expect(publish.status).toBe(200);

    // 3. Budi is nobody's member yet. The mint is where that is decided, and it
    //    is the ONE place a user-facing flow asks `IsMemberOf` — Siaran's gate
    //    and the profile's share it, while the post paywall answers the same
    //    question through its own query (see this file's own header).
    //
    //    TWO REFUSALS, not one. Budi holds no row at all, which `IsMemberOf`
    //    short-circuits to `none` before its predicate runs; Citra holds an
    //    `active` row whose paid period ended yesterday, which is the state
    //    spec §9 guarantees every member reaches and the only one that reaches
    //    that predicate. A status-only gate would mint her a token forever.
    const citra = await signUp(a, account("citra"));
    await grantMembership(citra.userId, rina.userId, new Date(Date.now() - DAY_MS));

    const mint = (token: string) =>
      a.request(`/streams/${stream.id}/watch-token`, {
        method: "POST",
        headers: authed(token),
      });
    expect((await mint(budi.token)).status).toBe(403);
    expect((await mint(citra.token)).status).toBe(403);

    await grantMembership(budi.userId, rina.userId, new Date(Date.now() + 30 * DAY_MS));

    const mintedRes = await mint(budi.token);
    expect(mintedRes.status).toBe(200);
    const minted = await mintedRes.json();
    expect(typeof minted.token).toBe("string");

    // 4. nginx re-authorises every proxied segment, by the id the PUBLIC
    //    playback URL carries — never by the key.
    const authRequest = (headers: Record<string, string>) =>
      a.request("/webhooks/mediamtx/auth-request", {
        headers: { "X-Mediamtx-Secret": STREAM_SECRET, ...headers },
      });

    const watched = await authRequest({
      "X-Mtx-Stream-Id": stream.id,
      "X-Watch-Token": minted.token,
    });
    expect(watched.status).toBe(200);
    expect(watched.headers.get("X-Stream-Key")).toBe(stream.streamKey);
    expect(await watched.text()).not.toContain(stream.streamKey);

    // The same request without the token — a stranger who has the public URL.
    const unwatched = await authRequest({ "X-Mtx-Stream-Id": stream.id });
    expect(unwatched.status).toBe(403);
    expect(unwatched.headers.get("X-Stream-Key")).toBeNull();

    // 5. The broadcast ends, through the hook MediaMTX actually fires.
    const lifecycle = await mediamtx("lifecycle", {
      hook: "offline",
      streamKey: `u/${stream.streamKey}`,
    });
    expect(lifecycle.status).toBe(200);

    const [row] = await db.select().from(userStreams).where(eq(userStreams.id, stream.id));
    expect(row.status).toBe("ended");
    expect(row.endedAt).not.toBeNull();

    // An ended session is not republishable.
    const republish = await mediamtx("auth", {
      action: "publish",
      path: `u/${stream.streamKey}`,
      query: "",
    });
    expect(republish.status).toBe(403);

    // And the retired namespace is refused rather than read as the surviving
    // one — the allow-list, still an allow-list.
    const stale = await mediamtx("lifecycle", {
      hook: "offline",
      streamKey: `live/${stream.streamKey}`,
    });
    expect(stale.status).toBe(404);
  });
});

/**
 * FLOW 4 — EVERY SURVIVING WORKER PASS RUNS WITHOUT THROWING. ALL SIX.
 *
 * `apps/worker/src/main.ts` runs six `PollLoop`s on two cadences, and Phase 8
 * deleted two more (`process-renewals` and `process-churn`) out from under
 * that file. Two of the six come out of the API's own composition root
 * (`bootstrapWorker`); the other four are constructed in `main.ts` itself from
 * classes that live in `apps/worker`. So this test constructs all six exactly
 * as `main.ts` does — including `selectMediaStorage` and `selectPaymentProvider`,
 * the SAME selectors the API's `bootstrap()` uses — and gives each one a real
 * row to act on.
 *
 * IMPORTED ACROSS THE WORKSPACE BOUNDARY rather than re-declared. The four
 * sweep classes are tested in `apps/worker/src/scheduled-passes.test.ts`
 * against in-memory doubles, deliberately: that workspace's `bun test` runs
 * from `apps/worker`, where `apps/api/.env` is never loaded, so nothing there
 * can reach a database. This file is the only place the passes and a real
 * schema can meet, and a local re-implementation of them would prove nothing
 * about the code the worker process actually runs. `scheduled-passes.ts`
 * imports only the API's dependency-free `log-safety` helper and its sibling
 * `poll-loop`, so importing it here drags no composition root along.
 *
 * "WITHOUT THROWING" IS THE FLOOR, NOT THE BAR. A pass over an empty database
 * cannot throw and proves nothing, so each of the six is handed exactly one row
 * it must move, and the assertion is the count of rows it moved. That is what
 * catches a pass that was constructed with the wrong repository, or that was
 * never constructed at all.
 *
 * THE SEEDS ARE CHOSEN NOT TO OVERLAP, and the overlap that matters is between
 * the reminder pass and the membership sweep: both walk `user_subscription`
 * rows with `status = 'active'`. `listExpiringActive` takes a window starting
 * at `now`, and `listExpiredActive` takes everything at or before it — so a
 * membership ending in two days belongs to exactly one of them and a
 * membership that ended an hour ago belongs to the other, and the exact counts
 * below are what would catch either query drifting across that line.
 */
test("FLOW: every surviving worker pass runs without throwing", async () => {
  const a = app();

  // ---- 1. The OUTBOX. It has no writer and no handler left; what it must
  // still do is claim a row an EARLIER DEPLOY wrote and fail it LOUDLY rather
  // than leaving it pending and silent. `grant_access` as a wire literal — it
  // is the type such a row actually carries.
  const outboxRepository = new DrizzleOutboxRepository(db);
  const { id: outboxId } = await outboxRepository.enqueue({
    eventType: "grant_access",
    payload: { subscriptionId: "3f1c9e0a-1111-4222-8333-444455556666" },
  });

  // ---- 2. The REMINDER pass. Nothing in this system renews, so a membership
  // ends and the member buys again — this pass is the only thing that tells
  // them to.
  const owner = await signUp(a, account("rina"));
  const expiringSoon = await signUp(a, account("andi"));
  await db
    .update(appUsers)
    .set({ whatsappNumber: "6281200000000" })
    .where(eq(appUsers.id, expiringSoon.userId));
  await grantMembership(expiringSoon.userId, owner.userId, new Date(Date.now() + 2 * DAY_MS));

  // ---- 3. The ORPHAN MEDIA sweep. A real upload through the real pipeline,
  // never claimed by a post, backdated past the 24-hour window.
  const orphanId = await uploadFixture(a, owner.token);
  await db
    .update(postMedia)
    .set({ createdAt: new Date(Date.now() - 25 * HOUR_MS) })
    .where(eq(postMedia.id, orphanId));

  // ---- 4. The MEMBERSHIP sweep. A member who never came back: `active` with a
  // period that ended an hour ago, holding `user_subscription_one_active`'s
  // slot against a purchase that will never free it any other way.
  const lapsed = await signUp(a, account("siti"));
  await grantMembership(lapsed.userId, owner.userId, new Date(Date.now() - HOUR_MS));

  // ---- 5. The PENDING-CHECKOUT cleanup. A real abandoned cart: bought through
  // the real checkout so there is a real invoice at the provider to cancel,
  // then backdated past the two-hour window.
  const seller = await signUp(a, account("budi"));
  expect(
    (await a.request("/users/me/payout", { method: "POST", headers: authed(seller.token) })).status
  ).toBe(200);
  const sellerTier = await (
    await a.request("/users/me/tiers", {
      method: "POST",
      headers: authed(seller.token),
      body: JSON.stringify({ name: "Anggota", priceAmount: 50_000 }),
    })
  ).json();
  const abandoner = await signUp(a, account("dewi"));
  const abandoned = await (
    await a.request("/users/budi/subscribe", {
      method: "POST",
      headers: authed(abandoner.token),
      body: JSON.stringify({ tierId: sellerTier.id }),
    })
  ).json();
  await db
    .update(userSubscriptions)
    .set({ createdAt: new Date(Date.now() - 3 * HOUR_MS) })
    .where(eq(userSubscriptions.id, abandoned.subscriptionId));

  // ---- 6. The USER-STREAM sweep. `user_stream_one_live` means a row stuck
  // `live` forever leaves its owner permanently unable to go live again, and a
  // lost lifecycle webhook is exactly how that happens. Inserted directly: a
  // bare `bootstrap()` has no streaming provider (see `test-env-preload.ts`),
  // and the row's AGE is the whole point.
  const [ghost] = await db
    .insert(userStreams)
    .values({
      ownerId: owner.userId,
      title: "Siaran yang tidak pernah selesai",
      streamKey: "ghost-stream-key",
      status: "live",
      startedAt: new Date(Date.now() - 13 * HOUR_MS),
    })
    .returning();

  // ---- The composition, exactly as `apps/worker/src/main.ts` builds it.
  const worker = bootstrapWorker();
  const mediaStorage = selectMediaStorage({
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET,
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION,
    nodeEnv: process.env.NODE_ENV,
  });
  const payments = selectPaymentProvider({
    secretKey: process.env.XENDIT_SECRET_KEY,
    splitRuleId: process.env.XENDIT_SPLIT_RULE_ID,
    nodeEnv: process.env.NODE_ENV,
  });
  // An `instanceof` check rather than a cast, the same reasoning
  // `worker-bootstrap.test.ts` gives for its own: under `NODE_ENV=test` the
  // fake is what must be selected, and the check itself is worth making.
  expect(payments).toBeInstanceOf(FakePaymentAdapter);
  const processOrphanSweep = new SweepOrphanMedia(new DrizzleMediaRepository(db), mediaStorage);
  const processMembershipSweep = new SweepExpiredMemberships(
    new DrizzleUserSubscriptionRepository(db)
  );
  const processStalePendingSweep = new SweepStalePendingCheckouts(
    new DrizzleUserSubscriptionRepository(db),
    payments
  );
  const processUserStreamSweep = new SweepStaleUserStreams(new DrizzleUserStreamRepository(db));

  // ---- All six, in the order the process starts them.
  const outboxResult = await worker.processOutbox.execute();
  expect(outboxResult.claimed).toBe(1);
  expect(outboxResult.sent).toBe(0);
  const [outboxRow] = await db.select().from(outbox).where(eq(outbox.id, outboxId));
  expect(outboxRow.lastError).toContain("no handler is registered");

  const orphanResult = await processOrphanSweep.execute();
  expect(orphanResult.considered).toBe(1);
  expect(orphanResult.deleted).toBe(1);
  expect(orphanResult.failed).toBe(0);
  expect(await db.select().from(postMedia).where(eq(postMedia.id, orphanId))).toHaveLength(0);

  const membershipSweepResult = await processMembershipSweep.execute();
  expect(membershipSweepResult.considered).toBe(1);
  expect(membershipSweepResult.retired).toBe(1);
  expect(membershipSweepResult.failed).toBe(0);

  const reminderResult = await worker.remindExpiringMemberships.execute();
  expect(reminderResult.considered).toBe(1);
  expect(reminderResult.reminded).toBe(1);
  expect(reminderResult.failed).toBe(0);
  expect(worker.email).toBeInstanceOf(FakeEmailAdapter);
  expect((worker.email as FakeEmailAdapter).sent).toHaveLength(1);
  expect(worker.messaging.notifier).toBeInstanceOf(FakeMessagingAdapter);
  expect((worker.messaging.notifier as FakeMessagingAdapter).notifications).toHaveLength(1);

  const stalePendingResult = await processStalePendingSweep.execute();
  expect(stalePendingResult.considered).toBe(1);
  expect(stalePendingResult.expired).toBe(1);
  expect(stalePendingResult.failed).toBe(0);
  // The row is free AND the invoice is dead — the two halves of closing the
  // double-charge window.
  expect((payments as FakePaymentAdapter).expiredInvoices).toHaveLength(1);

  const userStreamResult = await processUserStreamSweep.execute();
  expect(userStreamResult.considered).toBe(1);
  expect(userStreamResult.ended).toBe(1);
  expect(userStreamResult.failed).toBe(0);
  const [sweptStream] = await db.select().from(userStreams).where(eq(userStreams.id, ghost.id));
  expect(sweptStream.status).toBe("ended");
});
