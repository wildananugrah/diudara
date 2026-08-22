import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { MAX_UPLOAD_BYTES, UPLOAD_ERROR_CODE } from "@diudara/shared";
import { NotFoundError, ValidationError } from "../application/errors";
import { ImageRejectedError } from "../domain/image";
import { uuidParam, validateParams } from "../http/validate";
import {
  requireUserAuth,
  resolveViewerId,
  type UserAuthVariables,
} from "../http/user-auth.middleware";
import type { Dependencies } from "../bootstrap";

const NO_FILE_MESSAGE = "berkas foto wajib disertakan";

/**
 * **Spec §10 says an over-size upload is "rejected before it is read into
 * memory", and until the final whole-branch review nothing implemented that** —
 * the handler called `c.req.formData()` and `file.arrayBuffer()`, buffering the
 * whole body, and only then compared its length. `bodyLimit` is what makes the
 * sentence true: it refuses on the declared `Content-Length` and, absent one,
 * aborts the stream the moment it passes the ceiling.
 *
 * THE CEILING IS DELIBERATELY ABOVE `MAX_UPLOAD_BYTES`, not equal to it. A
 * multipart envelope carries boundaries, a field name and a filename around the
 * bytes, so a file of exactly the limit produces a body slightly over it — and
 * a `bodyLimit` set to the file limit would answer that with a bare 413 instead
 * of `UploadMedia`'s Bahasa sentence that names the limit in MB. This margin
 * keeps the good refusal for a file just over the line, and leaves `bodyLimit`
 * doing the one job it is here for: refusing a body nobody should ever buffer.
 */
const MULTIPART_ENVELOPE_ALLOWANCE = 64 * 1024;
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

/**
 * What a members-only post's image goes out with instead — Phase 6, the header
 * the comment above demanded (spec §8.1).
 *
 * `private` forbids every SHARED cache (an nginx layer, a CDN, a browser
 * profile shared between people) from storing it at all, and `no-store` stops
 * the caller's own browser keeping it after the entitlement that produced it
 * lapses. Both halves matter: `private` alone would still let a member's
 * browser replay a gated image for a year after they stopped paying.
 *
 * It is chosen by `MediaGateDecision.gated`, from THE SAME decision that
 * decided the bytes, and never recomputed at the response. See the return
 * statement of either handler.
 */
const GATED_CACHE_CONTROL = "private, no-store";

/** Same idiom as `postIdParams` in `routes/posts.ts`: a malformed `:id` is a 400 here, never a raw uuid-syntax error from the database driver. */
const mediaIdParams = z.object({ id: uuidParam });

export function mediaRoutes(
  deps: Pick<
    Dependencies,
    | "userTokenIssuer"
    | "userRepository"
    | "uploadMedia"
    | "mediaStorage"
    | "mediaEntitlement"
  >
) {
  const app = new Hono<{ Variables: UserAuthVariables }>();
  const requireAuth = requireUserAuth(deps.userTokenIssuer, deps.userRepository);

  app.post(
    "/media",
    // AUTH FIRST, deliberately: the body ceiling is a resource guard, and a
    // stranger with no session should be turned away before this process
    // reasons about their body at all. `bodyLimit` still runs ahead of the
    // handler's own `formData()`, which is all §10 requires.
    requireAuth,
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES + MULTIPART_ENVELOPE_ALLOWANCE }),
    async (c) => {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        // A body that is not multipart at all (a JSON POST, a raw byte stream).
        // Without this it reached `errorHandler` as an unhandled `TypeError`
        // and became a 500 — a caller error answered as if the server broke.
        throw new ValidationError(NO_FILE_MESSAGE, UPLOAD_ERROR_CODE.missingFile);
      }
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new ValidationError(NO_FILE_MESSAGE, UPLOAD_ERROR_CODE.missingFile);
      }
      const bytes = new Uint8Array(await file.arrayBuffer());

      // `UploadMedia` lets `ImageRejectedError` (a plain `Error`, not an
      // `AppError`) through unswallowed — only this route layer knows to turn
      // it into the 400 `errorHandler` can render, reusing the SAME Bahasa
      // message `processUpload` already carries rather than inventing a
      // second one, AND carrying the domain's own `code` onto the wire.
      //
      // Matched on the BASE class, not on each subclass: a fifth refusal added
      // in `domain/image.ts` then reaches the client correctly labelled without
      // this route changing. The client's copy now branches on that code, so a
      // refusal that arrived unlabelled would be described with the vaguest
      // sentence in the module — which is exactly the failure this replaced.
      try {
        const result = await deps.uploadMedia.execute({ ownerId: c.get("userId"), bytes });
        return c.json(result, 201);
      } catch (err) {
        if (err instanceof ImageRejectedError) {
          throw new ValidationError(err.message, err.code);
        }
        throw err;
      }
    }
  );

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

    // BARRIER TWO, and it runs BEFORE a single byte is touched.
    //
    // `resolveViewerId` rather than `requireAuth`: these routes are publicly
    // reachable — a public post's image must still load for a signed-out
    // reader — so a missing, malformed or expired token resolves to `null`
    // (which locks every gated image) instead of turning a public image into
    // a 401.
    //
    // **THE GATE RESOLVES THE ROW ITSELF, and it is the only read of it.**
    // This handler used to do its own `mediaRepository.findById` + 404 first,
    // which meant every image request paid TWO primary-key reads of the same
    // row and the surviving line read like a gate it was not. Deleting it left
    // 47/47 green (whole-branch review, MIN-3) because an id with no row is
    // ALREADY refused by `MediaEntitlement.decide`, with the identical 404 —
    // gated and absent are indistinguishable from outside either way (spec
    // §6.2). Pinned by "404s when the row has been deleted from the database
    // but its bytes remain in storage", which leaves the BYTES in place so only
    // a row lookup can produce the 404.
    //
    // Give the gate the ID, never a row this handler looked up: a barrier that
    // trusts its caller's row is opened by any later refactor that passes the
    // wrong one.
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    const gate = await deps.mediaEntitlement.decide({ mediaId: id, viewerId });
    // 404 rather than 403: media ids are stripped from the projection, so they
    // are not public knowledge, and a 403 would confirm which ids exist. It is
    // also what this route already returns for a missing row, so gated and
    // absent look identical from outside.
    if (!gate.allowed) throw new NotFoundError(NOT_FOUND_MESSAGE);

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
      // Decided by the SAME check that decided the bytes, never computed
      // separately. Computed apart, the two can disagree — and a shared cache
      // then holds gated images and serves them to strangers, which no
      // assertion on this route's status code would ever catch (spec §8.1).
      "Cache-Control": gate.gated ? GATED_CACHE_CONTROL : CACHE_CONTROL,
    });
  });

  // Same rule as `/media/:id` above, same reason — see that route's comment
  // for where Phase 6's entitlement check goes and why it cannot be a
  // redirect. Kept as a second, separate handler rather than a `?thumb=1`
  // query flag so the two are two lines the router can gate independently,
  // not one line a future change could gate halfway.
  app.get("/media/:id/thumb", validateParams(mediaIdParams), async (c) => {
    const { id } = c.get("validatedParams") as { id: string };

    // Same single read as the full route above, and for the same reason — see
    // that handler's comment (MIN-3). Pinned separately by "404s when the row
    // has been deleted from the database but its bytes remain in storage (thumb
    // route)".
    //
    // BARRIER TWO on the thumbnail, WRITTEN OUT AGAIN rather than shared with
    // the route above. That is the point of there being two handlers: the
    // thumbnail is the variant the feed actually renders, so a gate factored
    // into one place that only one handler remembered to call is precisely the
    // "gated halfway" failure this split exists to make impossible. Every test
    // for `/media/:id` has a twin for this route.
    const viewerId = await resolveViewerId(c, deps.userTokenIssuer, deps.userRepository);
    const gate = await deps.mediaEntitlement.decide({ mediaId: id, viewerId });
    // 404, not 403 — see the full route above.
    if (!gate.allowed) throw new NotFoundError(NOT_FOUND_MESSAGE);

    const object = await deps.mediaStorage.get(id, "thumb");
    if (object === null) throw new NotFoundError(NOT_FOUND_MESSAGE);

    // `new Uint8Array(...)` copies onto a concrete `ArrayBuffer` — `MediaObject.bytes`
    // is typed over the wider `ArrayBufferLike` (it may back onto a `SharedArrayBuffer`
    // depending on how the adapter read it), which Hono's `BodyRespond` does not accept.
    return c.body(new Uint8Array(object.bytes), 200, {
      "Content-Type": object.contentType,
      // Decided by the SAME check that decided the bytes, never computed
      // separately. Computed apart, the two can disagree — and a shared cache
      // then holds gated images and serves them to strangers, which no
      // assertion on this route's status code would ever catch (spec §8.1).
      "Cache-Control": gate.gated ? GATED_CACHE_CONTROL : CACHE_CONTROL,
    });
  });

  return app;
}
