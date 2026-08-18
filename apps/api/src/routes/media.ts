import { Hono } from "hono";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../application/errors";
import { UnsupportedImageError } from "../domain/image";
import { uuidParam, validateParams } from "../http/validate";
import {
  requireUserAuth,
  type UserAuthVariables,
} from "../http/user-auth.middleware";
import type { Dependencies } from "../bootstrap";

const NO_FILE_MESSAGE = "berkas foto wajib disertakan";
const NOT_FOUND_MESSAGE = "media not found";
// English, not Bahasa — `NotFoundError` is English at every one of its
// other ~54 call sites in this codebase (`"post not found"`,
// `"community not found"`, etc.), without exception. `ValidationError`/
// `ConflictError` copy IS Bahasa here (see `NO_FILE_MESSAGE` above, from
// Task 4) — that split is real, not an oversight: those are messages a
// human reads in a form; `NotFoundError` on this route is a status code
// with an internal label, matching the rest of the codebase's technical
// 404s.

/**
 * Immutable because the id names one exact re-encoded artefact — Task 4's
 * upload pipeline writes it once and never touches it again, so there is no
 * future version to invalidate this cache for THIS byte content.
 *
 * SAFE ONLY BECAUSE EVERY POST IS PUBLIC TODAY (Phase 3) — this is not a
 * property of the id, it is a property of the current phase, and Phase 6
 * breaks it. `public` licenses ANY downstream cache (an nginx layer, a CDN,
 * a browser shared with other profiles) to replay a cached 200 to a
 * DIFFERENT caller WITHOUT ever re-entering this handler, and
 * `max-age=31536000, immutable` keeps a member's own browser replaying it
 * for a year after their entitlement is revoked. Neither of those is a bug
 * today because there is nothing to gate; both become the exact hole §5.1
 * warns about the moment Phase 6 lands. When Phase 6 adds the entitlement
 * check named on each route below, it MUST also stop sending this header on
 * the gated path — `private, no-store` (or omitting caching entirely) for
 * any response the entitlement check gated, keeping `public, immutable`
 * only for media that stays ungated. Widening this header to cover a
 * response served before that check runs is the mistake this comment exists
 * to prevent.
 */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Same idiom as `postIdParams` in `routes/posts.ts`: a malformed `:id` is a 400 here, never a raw uuid-syntax error from the database driver. */
const mediaIdParams = z.object({ id: uuidParam });

export function mediaRoutes(
  deps: Pick<
    Dependencies,
    "userTokenIssuer" | "userRepository" | "uploadMedia" | "mediaStorage" | "mediaRepository"
  >
) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  const requireAuth = requireUserAuth(deps.userTokenIssuer, deps.userRepository);

  app.post("/media", requireAuth, async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ValidationError(NO_FILE_MESSAGE);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());

    // `UploadMedia` lets `UnsupportedImageError` (a plain `Error`, not an
    // `AppError`) through unswallowed — only this route layer knows to turn
    // it into the 400 `errorHandler` can render, reusing the SAME Bahasa
    // message `processUpload` already carries rather than inventing a
    // second one.
    try {
      const result = await deps.uploadMedia.execute({ ownerId: c.get("userId"), bytes });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof UnsupportedImageError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }
  });

  // Spec §5.1: "The API must never send the media URL to a non-member."
  // PHASE 6 GOES HERE, before `deps.mediaStorage.get` below — an
  // entitlement check that reads the row, decides whether the caller may
  // see it, and throws before a single byte is touched. This handler
  // reads the bytes out of `MediaStoragePort` and writes them into the
  // response BY HAND, on purpose: a redirect (302 to a signed URL, or to
  // the bucket directly) would hand the caller a URL that outlives
  // whatever check produced it, and Phase 6's gate would then be a
  // decision this route makes once and the internet gets to keep forever.
  // Do not "optimise" this into a redirect — read why above before you do.
  app.get("/media/:id", validateParams(mediaIdParams), async (c) => {
    const { id } = c.get("validatedParams") as { id: string };
    const row = await deps.mediaRepository.findById(id);
    if (row === null) throw new NotFoundError(NOT_FOUND_MESSAGE);

    const object = await deps.mediaStorage.get(id, "full");
    // A row with no bytes behind it (interrupted upload, manual bucket
    // interference) is absence from the caller's point of view — 404, never
    // a 500 from dereferencing `null`. Mirrors `MediaStoragePort.get`'s own
    // docstring.
    if (object === null) throw new NotFoundError(NOT_FOUND_MESSAGE);

    // `new Uint8Array(...)` copies onto a concrete `ArrayBuffer` — `MediaObject.bytes`
    // is typed over the wider `ArrayBufferLike` (it may back onto a `SharedArrayBuffer`
    // depending on how the adapter read it), which Hono's `BodyRespond` does not accept.
    return c.body(new Uint8Array(object.bytes), 200, {
      "Content-Type": object.contentType,
      "Cache-Control": CACHE_CONTROL,
    });
  });

  // Same rule as `/media/:id` above, same reason — see that route's comment
  // for where Phase 6's entitlement check goes and why it cannot be a
  // redirect. Kept as a second, separate handler rather than a `?thumb=1`
  // query flag so the two are two lines the router can gate independently,
  // not one line a future change could gate halfway.
  app.get("/media/:id/thumb", validateParams(mediaIdParams), async (c) => {
    const { id } = c.get("validatedParams") as { id: string };
    const row = await deps.mediaRepository.findById(id);
    if (row === null) throw new NotFoundError(NOT_FOUND_MESSAGE);

    const object = await deps.mediaStorage.get(id, "thumb");
    if (object === null) throw new NotFoundError(NOT_FOUND_MESSAGE);

    // `new Uint8Array(...)` copies onto a concrete `ArrayBuffer` — `MediaObject.bytes`
    // is typed over the wider `ArrayBufferLike` (it may back onto a `SharedArrayBuffer`
    // depending on how the adapter read it), which Hono's `BodyRespond` does not accept.
    return c.body(new Uint8Array(object.bytes), 200, {
      "Content-Type": object.contentType,
      "Cache-Control": CACHE_CONTROL,
    });
  });

  return app;
}
