import { Hono } from "hono";
import { z } from "zod";
import { ServiceUnavailableError } from "../application/errors";
import { uuidParam, validate, validateParams } from "../http/validate";
import {
  requireUserAuth,
  resolveViewerId,
  type UserAuthVariables,
} from "../http/user-auth.middleware";
import type { Dependencies } from "../bootstrap";

/**
 * `user_stream.title` is `varchar(140)`. Asserted as a literal in the route's
 * tests, never by importing this constant — the rule this project follows for
 * every limit a person can hit.
 */
const MAX_STREAM_TITLE_LENGTH = 140;

/**
 * *Mulai siaran*'s body. `visibility` is OPTIONAL and defaults to `public`
 * at the column (`user_stream.visibility`'s own default), so a client that
 * leaves the *Khusus anggota* checkbox alone sends nothing rather than a
 * literal — and, unlike a post's, an omitted value here can safely mean
 * "public" because there is no edit path that would silently un-gate an
 * existing row.
 *
 * `.trim()` before `.min(1)` so a whitespace-only title is a 400 rather than
 * a blank card in Siaran, and the same trimmed string is what gets stored —
 * route and column measure the same text, the cross-layer disagreement
 * `routes/posts.ts` records having shipped once.
 */
const startStreamSchema = z.object({
  title: z.string().trim().min(1).max(MAX_STREAM_TITLE_LENGTH),
  visibility: z.enum(["public", "members"]).optional(),
});

const streamIdParams = z.object({ id: uuidParam });

/**
 * `/streams` — Phase 7's Siaran (design spec §7, §8).
 *
 * FOUR ROUTES, TWO AUTH SHAPES, and the split is the point:
 *
 *  - `POST /streams`, `DELETE /streams/:id` and
 *    `POST /streams/:id/watch-token` are yours, behind `requireUserAuth`.
 *  - `GET /streams` is PUBLIC — spec §8, "visible to everyone signed in or
 *    not" — so it uses `resolveViewerId`, which degrades a missing, expired
 *    or epoch-stale token to `null` instead of throwing. The same shape
 *    `GET /users/feed` uses for `/beranda`, and for the same reason: Siaran
 *    is a publicly reachable page, and an auth-only listing would break it
 *    for a signed-out visitor.
 *
 * `POST /streams/:id/watch-token` (Task 5) is authenticated for a reason
 * worth stating: the credential it mints is issued to a NAMED viewer, and
 * re-minting it is the ONLY thing that keeps a lapsed membership out (design
 * spec §5). A forwarded token cannot be renewed precisely because renewing it
 * requires the member's own session.
 *
 * **`deps.startUserStream` is `undefined` exactly when
 * `Dependencies.streamingProvider` is** (see `selectStreamingProvider` in
 * bootstrap.ts): live streaming is not configured on this box. That is a 503
 * here, the same shape `POST /ai/messages` and
 * `POST /communities/:communityId/events` already use.
 * `deps.mintUserWatchToken` is `undefined` on a slightly DIFFERENT condition
 * — exactly when `STREAM_TOKEN_SECRET` is absent, mirroring
 * `Dependencies.authoriseStream` rather than `startUserStream` — because
 * signing a token needs that secret and nothing else. A relaxed dev box with
 * a `FakeStreamingAdapter` and no secrets can start a stream and cannot mint
 * a watch token; both answer 503 off their own dependency, neither infers the
 * other's.
 *
 * **`GET /streams` STILL WORKS on such a box, and that is deliberate.**
 * `deps.listLiveStreams` is never `undefined`: the listing reads rows and
 * derives each playback path from a row id, so it depends on no provider at
 * all. A listing that 503'd because nobody configured MediaMTX would take
 * Siaran down for every reader over a writer's dependency. `DELETE` is the
 * same — ending a row that already exists needs nothing from the provider,
 * and a creator on a box whose streaming was switched off after they went
 * live must still be able to stop.
 */
export function streamRoutes(
  deps: Pick<
    Dependencies,
    | "userTokenIssuer"
    | "userRepository"
    | "startUserStream"
    | "listLiveStreams"
    | "endOwnUserStream"
    | "mintUserWatchToken"
  >
) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  const requireAuth = requireUserAuth(deps.userTokenIssuer, deps.userRepository);

  app.post("/", requireAuth, validate(startStreamSchema), async (c) => {
    if (!deps.startUserStream) {
      throw new ServiceUnavailableError("siaran langsung belum tersedia di server ini");
    }
    const input = c.get("validated") as { title: string; visibility?: "public" | "members" };
    const started = await deps.startUserStream.execute({
      ownerId: c.get("userId"),
      title: input.title,
      // The column's own default is `public`; naming it here too would put
      // the same literal in two places, so the omitted case is passed
      // through as the string the schema already narrowed.
      visibility: input.visibility ?? "public",
    });
    return c.json(started, 201);
  });

  // `validateParams` before the use case for the reason `routes/posts.ts`
  // records: a non-uuid `:id` otherwise reaches a uuid column and 500s with
  // the failing SQL on stderr. A well-formed but unknown id still 404s from
  // the use case.
  app.delete<"/:id">("/:id", requireAuth, validateParams(streamIdParams), async (c) => {
    await deps.endOwnUserStream.execute({
      ownerId: c.get("userId"),
      streamId: c.req.param("id"),
    });
    return c.json({ ended: true });
  });

  /**
   * `POST /streams/:id/watch-token` — Task 5, design spec §5.
   *
   * `validateParams` FIRST, for the reason `DELETE /:id` above records: a
   * non-uuid `:id` otherwise reaches a uuid column and 500s with the failing
   * SQL on stderr.
   *
   * NEITHER THE TOKEN NOR THE STREAM KEY IS EVER LOGGED here or anywhere
   * downstream — `MintUserWatchToken` returns the token and the route puts it
   * straight in the body. The never-log rule this codebase has always applied to
   * stream keys covers this credential for the same reason.
   *
   * 200, not 201: nothing is created. The token is derived from a row that
   * already exists and a clock, and the same viewer re-mints every few
   * minutes for the whole broadcast.
   */
  app.post<"/:id/watch-token">(
    "/:id/watch-token",
    requireAuth,
    validateParams(streamIdParams),
    async (c) => {
      if (!deps.mintUserWatchToken) {
        throw new ServiceUnavailableError("siaran langsung belum tersedia di server ini");
      }
      return c.json(
        await deps.mintUserWatchToken.execute({
          viewerId: c.get("userId"),
          streamId: c.req.param("id"),
        })
      );
    }
  );

  app.get("/", async (c) => {
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    return c.json(await deps.listLiveStreams.execute({ viewerId }));
  });

  return app;
}
