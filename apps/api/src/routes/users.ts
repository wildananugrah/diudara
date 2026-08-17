import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
  completePasswordResetSchema,
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
import { validate } from "../http/validate";
import {
  requireUserAuth,
  resolveViewerId,
  type UserAuthVariables,
} from "../http/user-auth.middleware";
import { ValidationError } from "../application/errors";
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

/**
 * Largest `?q=` Jelajah will accept — review round 1, Minor: every other
 * user-supplied string on this router is bounded (`handle` 31,
 * `displayName` 255, `bio` 300 — see `@diudara/shared`'s signup/profile
 * schemas), but `q` had no bound at all on this public, unauthenticated,
 * unrate-limited route. `searchPublic`'s own metacharacter escaping (see
 * its docstring) already makes an arbitrarily long `q` cheap to execute —
 * this is about consistency with the rest of the router, not a
 * vulnerability being closed.
 */
const MAX_EXPLORE_QUERY_LENGTH = 100;

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

  // Task 2. Public, like `by-handle/:handle` — anyone can browse who follows
  // whom. `ListFollows` 404s an unknown handle the same way `GetUserProfile`
  // does; rows are already the public `FollowListRow` projection
  // (`handle`/`displayName`/`bio`), never a wider shape.
  app.get<"/:handle/followers">("/:handle/followers", async (c) => {
    const limit = parseFollowListLimit(c.req.query("limit"));
    const rows = await deps.listFollows.execute({
      handle: c.req.param("handle"),
      direction: "followers",
      limit,
    });
    return c.json(rows);
  });

  app.get<"/:handle/following">("/:handle/following", async (c) => {
    const limit = parseFollowListLimit(c.req.query("limit"));
    const rows = await deps.listFollows.execute({
      handle: c.req.param("handle"),
      direction: "following",
      limit,
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
    const result = await deps.exploreUsers.execute({ q, limit });
    return c.json(result);
  });

  return app;
}
