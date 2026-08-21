import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
  completePasswordResetSchema,
  MAX_EXPLORE_QUERY_LENGTH,
  requestPasswordResetSchema,
  updateProfileSchema,
  userLoginSchema,
  userSignupSchema,
  type CompletePasswordResetInput,
  type RequestPasswordResetInput,
  type UpdateProfileInput,
  type UserLoginInput,
  type UserSignupInput,
} from "@diudara/shared";
import { uuidParam, validate, validateParams } from "../http/validate";
import {
  requireUserAuth,
  resolveViewerId,
  type UserAuthVariables,
} from "../http/user-auth.middleware";
import { ServiceUnavailableError, ValidationError } from "../application/errors";
import { DEFAULT_FOLLOW_LIST_LIMIT } from "../application/use-cases/follow-user";
import { DEFAULT_EXPLORE_LIMIT } from "../application/use-cases/explore-users";
import type { Dependencies } from "../bootstrap";

/**
 * Largest page a caller may ask for — same shape as `routes/analytics.ts`'s
 * `MAX_PAGE_LIMIT`, and for the same reason: a REFUSAL rather than a silent
 * clamp, so a client asking for more than this can tell "you get 100" from
 * "that was a malformed request".
 */
const MAX_FOLLOW_LIST_LIMIT = 100;

const followListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_FOLLOW_LIST_LIMIT).optional(),
});

/** `?limit=` for the follower/following lists, parsed and defaulted — mirrors `routes/analytics.ts`'s `parsePageQuery`. */
function parseFollowListLimit(raw: string | undefined): number {
  const parsed = followListQuerySchema.safeParse({
    // Omitted rather than passed as `undefined`-from-empty-string: `?limit=`
    // would otherwise coerce to 0 and fail the minimum with a confusing message.
    ...(raw === undefined || raw === "" ? {} : { limit: raw }),
  });
  if (!parsed.success) {
    throw new ValidationError(
      `invalid limit: must be an integer between 1 and ${MAX_FOLLOW_LIST_LIMIT}`
    );
  }
  return parsed.data.limit ?? DEFAULT_FOLLOW_LIST_LIMIT;
}

/**
 * Largest page Jelajah's `?limit=` may ask for, applied to EACH of its three
 * lists (results/newest/mostFollowed) independently — same value and same
 * "refuse rather than silently clamp" reasoning as `MAX_FOLLOW_LIST_LIMIT`
 * above, kept as its own constant rather than reused because the two caps
 * are free to diverge later without either accidentally moving the other.
 */
const MAX_EXPLORE_LIMIT = 100;

/*
 * `MAX_EXPLORE_QUERY_LENGTH` — review round 1, Minor: every other
 * user-supplied string on this router is bounded (`handle` 31, `displayName`
 * 255, `bio` 300 — see `@diudara/shared`'s signup/profile schemas), but `q`
 * had no bound at all on this public, unauthenticated, unrate-limited route.
 * `searchPublic`'s own metacharacter escaping (see its docstring) already
 * makes an arbitrarily long `q` cheap to execute — this is about consistency
 * with the rest of the router, not a vulnerability being closed.
 *
 * IT USED TO BE DECLARED HERE, PRIVATELY, and that is what the final review's
 * I3 turned on: only the server knew the number, so `JelajahPage` neither
 * bounded its input nor bounded what it sent, and the 400 this schema produces
 * reached the screen verbatim — in English — taking both discovery rails down
 * with it. It now lives in `@diudara/shared` alongside the signup/login schemas,
 * imported by BOTH sides. See that constant's own docstring for why a second
 * literal on the client would have re-created a defect this project has already
 * shipped once.
 */
const exploreQuerySchema = z.object({
  q: z.string().max(MAX_EXPLORE_QUERY_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_EXPLORE_LIMIT).optional(),
});

/** `?q=`/`?limit=` for `GET /users/explore`, parsed and defaulted — mirrors `parseFollowListLimit` above. */
function parseExploreQuery(raw: {
  q: string | undefined;
  limit: string | undefined;
}): { q: string | undefined; limit: number } {
  const parsed = exploreQuerySchema.safeParse({
    ...(raw.q === undefined ? {} : { q: raw.q }),
    // Omitted rather than passed as `undefined`-from-empty-string: `?limit=`
    // would otherwise coerce to 0 and fail the minimum with a confusing message.
    ...(raw.limit === undefined || raw.limit === "" ? {} : { limit: raw.limit }),
  });
  if (!parsed.success) {
    throw new ValidationError(
      `invalid query: q must be at most ${MAX_EXPLORE_QUERY_LENGTH} characters, ` +
        `limit must be an integer between 1 and ${MAX_EXPLORE_LIMIT}`
    );
  }
  return { q: parsed.data.q, limit: parsed.data.limit ?? DEFAULT_EXPLORE_LIMIT };
}

/**
 * `POST /users/me/tiers`'s body — SHAPE only. Every business rule (price must
 * be positive, an owner must have a connected payout account, the billing
 * cycle 5a actually supports) is `ManageUserTiers.create`'s job, not this
 * schema's — see that method's own docstring for why. This exists only to
 * turn a malformed body (missing `name`, a non-numeric `priceAmount`) into a
 * 400 before it can reach `input.name.trim()` on `undefined`.
 *
 * The failure message is hand-written Bahasa rather than zod's own English
 * issue text, mirroring `parseFollowListLimit`/`parseExploreQuery` above.
 */
const createUserTierSchema = z.object({
  name: z.string().trim().min(1),
  priceAmount: z.number(),
  billingCycle: z.string().trim().min(1).optional(),
});

function parseCreateUserTierBody(raw: unknown): {
  name: string;
  priceAmount: number;
  billingCycle?: string;
} {
  const parsed = createUserTierSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      "Nama dan harga tingkatan wajib diisi dengan format yang benar."
    );
  }
  return parsed.data;
}

/**
 * `PATCH /users/me/tiers/:tierId`'s body. `is_active` is the only column
 * `UserTierRepositoryPort` lets a caller flip (see its `deactivate` doc
 * comment — there is no `reactivate`), so `isActive: true` is refused here
 * rather than silently accepted and ignored.
 */
const patchUserTierSchema = z.object({ isActive: z.literal(false) });

function parsePatchUserTierBody(raw: unknown): { isActive: false } {
  const parsed = patchUserTierSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(
      "Saat ini tingkatan hanya dapat dinonaktifkan, dengan mengirim { isActive: false }."
    );
  }
  return parsed.data;
}

/**
 * `POST /users/:handle/subscribe`'s body — SHAPE only, exactly as
 * `createUserTierSchema` above is. Every rule that decides whether this
 * purchase may happen (the tier is active and belongs to this owner, the owner
 * can be paid, the buyer is not the owner and is not already a member) is
 * `StartUserSubscription`'s, and none of it can be expressed here.
 *
 * `tierId` is the ONLY field. The amount is read from the tier server-side and
 * never accepted from a client — it is what Task 7's webhook compares the
 * provider's claimed amount against, so a client-supplied price would make that
 * comparison meaningless. The buyer is the SESSION, never the body.
 */
const subscribeSchema = z.object({ tierId: uuidParam });

function parseSubscribeBody(raw: unknown): { tierId: string } {
  const parsed = subscribeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("Pilih tingkatan keanggotaan yang ingin Anda beli.");
  }
  return parsed.data;
}

/**
 * The caller's IP, recorded (hashed) against every password-reset request
 * for forensic/audit value — see `RequestPasswordReset`'s own docstring for
 * why it is NO LONGER used to enforce a rate limit (review finding F4).
 *
 * Reads the LAST `X-Forwarded-For` entry, not the first — fixed by the same
 * review finding, which measured 30 requests with a ROTATED header all
 * sailing past the (then-enforced) cap of 10 by reading the FIRST entry,
 * which is CLIENT-SUPPLIED: anyone can put whatever they like at the front
 * of that header. The LAST entry is what the proxy closest to this process
 * appended, if one does — the only position a chain of proxies cannot let a
 * client forge, since each hop can only APPEND, never rewrite what came
 * before it. Pinned by this function's own test:
 * `describe("clientIp")` in `users.test.ts`.
 *
 * THIS DOES NOT, BY ITSELF, MAKE THE VALUE TRUSTWORTHY. This repository has
 * no committed nginx configuration for the general `/users/...` API surface
 * that proves anything ever appends to this header at all —
 * `infra/nginx/live-hls.conf.template` is a fragment scoped to `/live/`,
 * `/whip/` and `/webhooks/mediamtx/` only; the real deployment's general
 * proxy lives in "the real public HTTPS server block", outside this
 * repository (see that file's own header comment). Reading the last entry
 * is the correct thing to do IF a trusted proxy is ever verified in front
 * of this box; it does not conjure one. `null` when the header is absent,
 * which every test in this suite hits by default (`.request()` never sets
 * it) — `RequestPasswordReset` accepts a `null` ip and simply records no hash.
 */
export function clientIp(c: Context): string | null {
  const header = c.req.header("x-forwarded-for");
  if (!header) return null;
  const entries = header.split(",");
  const last = entries[entries.length - 1]?.trim();
  return last && last.length > 0 ? last : null;
}

/**
 * `POST /users/signup` and `POST /users/login` — a personal account, distinct
 * from creator auth mounted at `/auth`. Neither route is behind
 * `requireUserAuth`: signup has no session yet, and login is how one is
 * obtained.
 *
 * `GET /users/by-handle/:handle` is ALSO public — anyone can browse a
 * profile without authenticating, by design (spec §3.2) — but
 * `GET /users/me` and `PATCH /users/me` are behind `requireUserAuth`, applied
 * per-route rather than via `app.use("*", ...)` so it never accidentally
 * guards signup/login/by-handle too (the same reason `routes/analytics.ts`
 * mounts `requireAuth` per-route instead of on `"*"`).
 *
 * Task 2 (profiles and following) adds four more: `POST`/`DELETE
 * /:handle/follow` (behind `requireUserAuth` — following requires a session)
 * and the public `GET /:handle/followers`/`/:handle/following` lists. All
 * four share `by-handle/:handle`'s handle-normalisation forgiveness (a
 * leading `@` still resolves) through `FollowUser`/`ListFollows` themselves.
 */
export function userRoutes(
  deps: Pick<
    Dependencies,
    | "registerUser"
    | "authenticateUser"
    | "userTokenIssuer"
    | "userRepository"
    | "getUserProfile"
    | "updateUserProfile"
    | "requestPasswordReset"
    | "completePasswordReset"
    | "followUser"
    | "listFollows"
    | "exploreUsers"
    | "maxPostImages"
    | "connectUserPayout"
    | "getUserPayoutStatus"
    | "manageUserTiers"
    | "startUserSubscription"
    | "listSubscribers"
  >
) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  const requireAuth = requireUserAuth(deps.userTokenIssuer, deps.userRepository);

  app.post("/signup", validate(userSignupSchema), async (c) => {
    const input = c.get("validated") as UserSignupInput;
    // `{ ok: true }` only — see `RegisterUser`'s own docstring for why a
    // duplicate email must return exactly this and nothing more.
    const result = await deps.registerUser.execute(input);
    return c.json(result, 201);
  });

  app.post("/login", validate(userLoginSchema), async (c) => {
    const input = c.get("validated") as UserLoginInput;
    const result = await deps.authenticateUser.execute(input);
    return c.json(result, 200);
  });

  // Task 5. Public, like signup/login — there is no session yet. Always
  // 200 `{ ok: true }`, no matter which of `RequestPasswordReset`'s four
  // internal cases fired — see that class's own docstring for why the
  // shape must be identical across all of them.
  app.post("/password-reset/request", validate(requestPasswordResetSchema), async (c) => {
    const input = c.get("validated") as RequestPasswordResetInput;
    const result = await deps.requestPasswordReset.execute({ email: input.email, ip: clientIp(c) });
    return c.json(result, 200);
  });

  // Task 5. Public — the token IS the credential; there is nothing else to
  // authenticate with. A missing/expired/used token is a 401 via
  // `UnauthorizedError`, one identical message for all three — see
  // `CompletePasswordReset`'s own docstring.
  app.post("/password-reset/complete", validate(completePasswordResetSchema), async (c) => {
    const input = c.get("validated") as CompletePasswordResetInput;
    const result = await deps.completePasswordReset.execute({
      token: input.token,
      newPassword: input.newPassword,
    });
    return c.json(result, 200);
  });

  // Public. Bare handle — the `@` is a web URL convention only; encoding it
  // into every caller/log line is the cost of putting it in the API path
  // instead. `normalizeHandle` (inside `GetUserProfile`) strips one leading
  // `@` if a client sends it anyway, so a mistake here is forgiving rather
  // than a 404.
  app.get<"/by-handle/:handle">("/by-handle/:handle", async (c) => {
    // Public route: `resolveViewerId` NEVER throws, unlike `requireAuth` —
    // a missing/invalid token resolves to `null` (anonymous), not a 401,
    // because this route never required a session. See its own docstring
    // for why `null` here is load-bearing (`PublicUserProfile.viewerFollows`).
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    const profile = await deps.getUserProfile.execute(c.req.param("handle"), viewerId);
    return c.json(profile);
  });

  app.get<"/me">("/me", requireAuth, async (c) => {
    const profile = await deps.getUserProfile.executeOwn(c.get("userId"));
    return c.json(profile);
  });

  app.patch<"/me">("/me", requireAuth, validate(updateProfileSchema), async (c) => {
    const patch = c.get("validated") as UpdateProfileInput;
    const updated = await deps.updateUserProfile.execute({ userId: c.get("userId"), patch });
    return c.json(updated);
  });

  /**
   * Phase 5a Task 3. Whether money can reach THIS user yet — the switch every
   * later task in the phase depends on: a tier cannot be published without it
   * and an invoice has nowhere to settle.
   *
   * Both verbs answer with the same three booleans and NEVER the account id
   * itself. The id belongs on the server side of `for_account_id`; a client has
   * no use for it, and a value on the wire is a value that ends up pasted
   * somewhere.
   *
   * `available` is a property of the SERVER, not of the user, which is why it is
   * composed here rather than inside `GetUserPayoutStatus` — that use case reads
   * one column and has no business knowing what `bootstrap()` wired. It is the
   * exact same `connectUserPayout !== undefined` the POST below turns into a
   * 503, so the two can never disagree. Without it, `connected: false,
   * provisioning: false` means both "you have not connected yet" and "this
   * server has no payment provider at all", and only the first is fixable by
   * pressing a button. The creator dashboard shipped that ambiguity once
   * (`routes/payment-account.ts`), so this one does not.
   *
   * `payout` is NOT in `RESERVED_HANDLES`, deliberately. The route-derived guard
   * in `users.test.ts` reads only the FIRST segment after `/users/` — here that
   * is `me`, which `HANDLE_PATTERN` already makes unregisterable at 2
   * characters — so nothing under `/me/` can ever shadow a profile, and
   * reserving an ordinary word to prevent a collision that cannot occur would
   * take it from users for nothing. See `domain/handle.ts` on `me`/`by-handle`/
   * `password-reset`, which are absent from that list for the same reason.
   */
  app.get<"/me/payout">("/me/payout", requireAuth, async (c) => {
    const status = await deps.getUserPayoutStatus.execute(c.get("userId"));
    return c.json({ ...status, available: deps.connectUserPayout !== undefined });
  });

  /**
   * IDEMPOTENT, and 200 rather than 201 for that reason — the same contract as
   * the follow routes below: the response is the RESULTING state, whether or not
   * this call is what changed it. A user on a slow connection will press this
   * twice, and a Xendit MANAGED sub-account is a KYC entity with NO delete
   * endpoint, so the one outcome that must be impossible is a second account.
   * `ConnectUserPayout` guarantees that by claiming the column BEFORE it calls
   * the provider — read its docstring before changing anything here.
   */
  app.post<"/me/payout">("/me/payout", requireAuth, async (c) => {
    // `undefined` EXACTLY when this box has no payment provider at all. Same
    // 503, and the same wording, as `routes/payment-account.ts`: this box is
    // fine, there is just nothing to connect an account to.
    if (!deps.connectUserPayout) {
      throw new ServiceUnavailableError("pembayaran belum dikonfigurasi di server ini.");
    }
    const status = await deps.connectUserPayout.execute(c.get("userId"));
    return c.json({ ...status, available: true }, 200);
  });

  /**
   * Task 4 of Phase 5a. Pengaturan's tier editor: what a creator sells on
   * their OWN profile, distinct from `/dashboard/*`'s community tiers
   * (`routes/tiers.ts`, table `membership_tier`) — see `ManageUserTiers`'s
   * own docstring.
   *
   * Static segments (`me/tiers`, `me/tiers/:tierId`), like `me/payout` above
   * — nothing a handle could ever shadow, since `me` is 2 characters and
   * already unregisterable under `HANDLE_PATTERN` before this route existed.
   * `RESERVED_HANDLES` gains nothing from this route; see `domain/handle.ts`.
   *
   * `GET` returns the owner's OWN management view — every tier they have
   * ever defined, active and deactivated alike — never the public
   * `listActiveByOwner` projection a visitor's profile shows (Task 5).
   */
  app.get<"/me/tiers">("/me/tiers", requireAuth, async (c) => {
    const tiers = await deps.manageUserTiers.list(c.get("userId"));
    return c.json(tiers);
  });

  /**
   * `ManageUserTiers.create` is where the money-has-nowhere-to-go gate lives
   * — a tier cannot be published without a CONNECTED payout account (spec
   * §5). This handler does no business validation itself; it only turns a
   * malformed body into a 400 before that method ever sees it.
   */
  app.post<"/me/tiers">("/me/tiers", requireAuth, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ValidationError("Isi permintaan harus berupa JSON yang valid.");
    }
    const input = parseCreateUserTierBody(raw);
    const created = await deps.manageUserTiers.create({ ownerId: c.get("userId"), ...input });
    return c.json(created, 201);
  });

  /**
   * The ONLY edit `UserTierRepositoryPort` exposes: withdrawing a tier from
   * sale. `ManageUserTiers.deactivate` 404s a tier that belongs to a
   * different owner — one owner cannot edit another's tier — and never
   * touches `user_subscription`, so an existing member's subscription keeps
   * resolving after their tier is withdrawn (spec §4).
   */
  app.patch<"/me/tiers/:tierId">(
    "/me/tiers/:tierId",
    requireAuth,
    validateParams(z.object({ tierId: uuidParam })),
    async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new ValidationError("Isi permintaan harus berupa JSON yang valid.");
      }
      parsePatchUserTierBody(raw);
      const updated = await deps.manageUserTiers.deactivate({
        ownerId: c.get("userId"),
        tierId: c.req.param("tierId"),
      });
      return c.json(updated, 200);
    }
  );

  /**
   * Task 6 of Phase 5b (spec §8) — a creator's own subscriber list.
   *
   * **THIS IS PRIVATE DATA.** Owner-only by construction rather than by a
   * check: there is no handle parameter on this route, only `requireAuth`
   * and `c.get("userId")`, so the only list a caller can ever ask for is
   * their own. `ListSubscribers.execute` is never given anything else.
   *
   * The wire projection is CLOSED — `{ handle, displayName, since }`, and
   * only CURRENTLY subscribed members: `status = 'active'` AND
   * `current_period_end > now`, the same definition `IsMemberOf` uses. See
   * `ListSubscribers`'s own docstring and
   * `UserSubscriptionRepositoryPort.listActiveSubscribers`'s for the full
   * reasoning — neither `isMemberOf` nor `IsMemberOf` itself is touched by
   * this route.
   *
   * Static (`me/subscribers`), like `me/payout` and `me/tiers` above it:
   * `me` is 2 characters, already unregisterable under `HANDLE_PATTERN`
   * before this route existed, so `RESERVED_HANDLES` gains nothing from it
   * — see the route-derived guard in `users.test.ts`.
   */
  app.get<"/me/subscribers">("/me/subscribers", requireAuth, async (c) => {
    const result = await deps.listSubscribers.execute(c.get("userId"));
    return c.json(result);
  });

  /**
   * Task 7 of images (design spec §6). Public and cheap — no auth, no
   * database read, just the number `bootstrap()` already resolved from
   * `MAX_POST_IMAGES` at boot. The web is a static build served by nginx and
   * cannot read this process's env, so it fetches this once to learn the
   * cap `postRoutes`' `.max()` enforces server-side.
   *
   * A STATIC path, mounted above every `/:handle` route on this router for
   * the same reason `/explore` is (`limits` is 6 lowercase characters, so
   * `HANDLE_PATTERN` would let someone register it and shadow this route —
   * `RESERVED_HANDLES` in `domain/handle.ts` closes that, and
   * `users.test.ts`'s route-derived guard fails loudly if this ever falls
   * out of sync with it).
   *
   * Deliberately advisory only from the web's side: the server stays the
   * authority via the schema's own `.max()`, so a fetch failure here must
   * never be able to make the composer refuse to open.
   */
  app.get<"/limits">("/limits", (c) => {
    return c.json({ maxPostImages: deps.maxPostImages });
  });

  // Task 2. Behind `requireUserAuth`: following requires a session, unlike
  // every other route on this router mounted above `/me`. `FollowUser`
  // itself resolves the handle, 404s an unknown one, and 409s a self-follow
  // in Bahasa Indonesia BEFORE ever touching `FollowRepositoryPort.follow`/
  // `unfollow` — see that class's own docstring for why that ordering is
  // the entire point of this use case existing. Both directions return the
  // RESULTING state with 200, whether or not anything changed — idempotent
  // by design (design spec §7): a double-tap must not error.
  app.post<"/:handle/follow">("/:handle/follow", requireAuth, async (c) => {
    const result = await deps.followUser.execute({
      followerId: c.get("userId"),
      handle: c.req.param("handle"),
      action: "follow",
    });
    return c.json(result, 200);
  });

  app.delete<"/:handle/follow">("/:handle/follow", requireAuth, async (c) => {
    const result = await deps.followUser.execute({
      followerId: c.get("userId"),
      handle: c.req.param("handle"),
      action: "unfollow",
    });
    return c.json(result, 200);
  });

  /**
   * Task 6 of Phase 5a (spec §6) — buying a membership from a person, and the
   * moment money actually moves.
   *
   * Behind `requireAuth`: buying is signed-in only, so a signed-out visitor
   * pressing "Jadi anggota" gets a 401 and is sent to Masuk first. The buyer is
   * therefore `c.get("userId")` — the session — and never anything in the body,
   * which carries only the tier id.
   *
   * DYNAMIC, like the follow routes above it: `/:handle/subscribe` cannot
   * shadow, and cannot be shadowed by, any of this router's static paths, since
   * Hono ranks static segments above dynamic ones.
   *
   * 201, not 200: this call CREATES a pending subscription and a pending
   * transaction, which outlive the response whether or not the buyer ever pays
   * the invoice. Same status the dashboard's `POST /c/:slug/checkout` returns
   * for the same reason.
   */
  app.post<"/:handle/subscribe">("/:handle/subscribe", requireAuth, async (c) => {
    // `undefined` EXACTLY when this box has no payment provider at all — same
    // 503 and the same wording as `POST /users/me/payout` above. The route stays
    // registered either way, unlike `/c/:slug/checkout`, so a buyer is told why
    // rather than getting the 404 of a path that does not exist.
    if (!deps.startUserSubscription) {
      throw new ServiceUnavailableError("pembayaran belum dikonfigurasi di server ini.");
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ValidationError("Isi permintaan harus berupa JSON yang valid.");
    }
    const { tierId } = parseSubscribeBody(raw);
    const result = await deps.startUserSubscription.execute({
      subscriberId: c.get("userId"),
      handle: c.req.param("handle"),
      tierId,
    });
    return c.json(result, 201);
  });

  // Task 2. Public, like `by-handle/:handle` — anyone can browse who follows
  // whom. `ListFollows` 404s an unknown handle the same way `GetUserProfile`
  // does; rows are the public projection (`handle`/`displayName`/`bio`) plus
  // `viewerFollows`, never a wider shape.
  //
  // FINAL REVIEW, ITEM 1: these two and `/explore` below now run
  // `resolveViewerId`, exactly as `by-handle/:handle` has since Task 2, and for
  // the identical reason — they are PUBLIC BUT NOT ANONYMOUS. That viewer id is
  // the only input to the per-row `viewerFollows`, without which `/@you/mengikuti`
  // showed "Ikuti" against every single person you follow. `resolveViewerId`
  // never throws: a missing, malformed or expired token resolves to `null`
  // (anonymous) rather than a 401, so a stale token can never lock a visitor out
  // of browsing a list.
  app.get<"/:handle/followers">("/:handle/followers", async (c) => {
    const limit = parseFollowListLimit(c.req.query("limit"));
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    const rows = await deps.listFollows.execute({
      handle: c.req.param("handle"),
      direction: "followers",
      limit,
      viewerId,
    });
    return c.json(rows);
  });

  app.get<"/:handle/following">("/:handle/following", async (c) => {
    const limit = parseFollowListLimit(c.req.query("limit"));
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    const rows = await deps.listFollows.execute({
      handle: c.req.param("handle"),
      direction: "following",
      limit,
      viewerId,
    });
    return c.json(rows);
  });

  // Task 3. Public, like `by-handle`/`followers`/`following` above — Jelajah
  // is the discovery screen a new user with an empty follow graph lands on,
  // and there is nothing here a signed-out visitor should not see. A static
  // path (`/explore`), not `/:handle`, so it cannot collide with any of the
  // dynamic handle routes above regardless of registration order.
  //
  // `q` is optional and may be empty/whitespace-only — `ExploreUsers`
  // treats that as the screen's default state (empty `results`, both other
  // lists still populated), not an error. See that class's own docstring.
  app.get<"/explore">("/explore", async (c) => {
    const { q, limit } = parseExploreQuery({ q: c.req.query("q"), limit: c.req.query("limit") });
    // See the two list routes above for why a PUBLIC route resolves a viewer.
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    const result = await deps.exploreUsers.execute({ q, limit, viewerId });
    return c.json(result);
  });

  return app;
}
