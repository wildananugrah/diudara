import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { MediaRepositoryPort } from "../ports/media-repository.port";
import type { PostEditUnitOfWorkPort } from "../ports/post-edit-unit-of-work.port";
import type { PostRepositoryPort } from "../ports/post-repository.port";
import { MEMBERS_ONLY, toPostView, type PostView } from "./post-views";

export { MAX_POST_BODY_LENGTH };

const EMPTY_MESSAGE = "kiriman tidak boleh kosong";
const TOO_LONG_MESSAGE = `kiriman maksimal ${MAX_POST_BODY_LENGTH} karakter`;
const NOT_YOURS_MESSAGE = "kiriman ini bukan milik Anda";
const MEDIA_NOT_YOURS_MESSAGE = "foto tidak ditemukan atau bukan milik Anda";
const MEDIA_TAKEN_MESSAGE = "foto sudah dipakai kiriman lain";
const MEDIA_DUPLICATE_MESSAGE = "foto yang sama tidak boleh dipakai dua kali";
const MEDIA_VANISHED_MESSAGE = "foto sudah tidak tersedia, silakan unggah ulang";
const NO_IMAGE_FOR_MEMBERS_MESSAGE = "kiriman khusus anggota harus punya minimal satu foto";

/**
 * Spec §7: `visibility = 'members'` protects nothing without at least one
 * image, so it is refused — on create AND edit, through this ONE function,
 * so the two paths cannot drift into different answers for the same
 * question. Checked against `mediaCount`, the state the caller's operation
 * is PRODUCING, never what the row currently holds — see each call site for
 * how it arrives at that number.
 */
function requireImageWhenLocked(visibility: string, mediaCount: number): void {
  if (visibility === MEMBERS_ONLY && mediaCount === 0) {
    throw new ValidationError(NO_IMAGE_FOR_MEMBERS_MESSAGE);
  }
}

/**
 * **A claim that attached fewer rows than it was given has LOST A RACE, and it
 * must not pass quietly.**
 *
 * Final whole-branch review, Important 4 (2026-08-18). `requireAttachable`
 * reads the rows and then `claim` writes them; between those two the orphan
 * sweep can delete a row it listed as unclaimed (a composer left open
 * overnight, then used). Before this, `claim` returned nothing and the
 * missing id was a silent no-op — the author's post came back with fewer
 * photos than they sent, and nothing said so.
 *
 * A 409 rather than a 500 because the person can act on it — but **WHICH thing
 * they should do depends on which race was lost, and the two answers point in
 * opposite directions** (re-review, follow-up 2). A short claim now has two
 * causes, not one: the sweep deleted the row (upload it again), or MAJ-2's
 * guard refused it because another post holds it (the photo is fine — it is
 * somewhere else). Telling somebody to re-upload a file they still have,
 * because a DIFFERENT post claimed it, sends them down the wrong path
 * entirely. So this reads the ids back and picks the sentence that is true:
 * `MEDIA_TAKEN_MESSAGE` when a row survives under another post,
 * `MEDIA_VANISHED_MESSAGE` when it is really gone.
 *
 * `MEDIA_TAKEN_MESSAGE` is the SAME sentence `requireAttachable` gives for the
 * same situation caught earlier, deliberately: one situation, one sentence,
 * whichever check happens to notice it. The STATUS differs and should — 400
 * when the request was already wrong when it arrived, 409 when it lost a race
 * while in flight.
 *
 * **UPDATED, Task 5 fix round 2.** This docstring used to record that "the
 * post row DOES already exist by the time this fires on create... a loud
 * wrong-ish status is still strictly better than silent data loss" — true on
 * 2026-08-18, three days before `visibility` became writable, when the worst
 * case this left behind was a PUBLIC post with fewer photos than sent: an
 * annoyance. Task 5 changed what a lost claim race can leave behind on
 * create: a `members` post whose claim never fully lands is the EXACT
 * forbidden state the whole task exists to prevent, not an inconvenience,
 * and the original trade-off was never weighed against that outcome because
 * that outcome did not exist yet. So `CreatePost` and `EditPost` alike now
 * run their post write and their media claim inside ONE transaction (see
 * `PostEditUnitOfWorkPort`) — this error rolls BOTH back on either path, and
 * a caller who sees it can retry knowing nothing was left half-written,
 * gated or not.
 */
async function requireFullyClaimed(
  media: MediaRepositoryPort,
  postId: string,
  claimed: number,
  ids: string[]
): Promise<void> {
  if (claimed === ids.length) return;
  // WHICH race was lost decides which sentence the person reads, and the two
  // point in opposite directions. Re-read the ids — one extra query, on the
  // failure path only, and never on the path everybody takes.
  //
  // The read happens inside this transaction AFTER the claim came back short,
  // so under READ COMMITTED it takes a fresh snapshot and sees whatever the
  // winner committed. A row still present but parented to a DIFFERENT post is
  // the MAJ-2 race: another post took the photo. A row that is simply gone is
  // the sweep race: the bytes really are not there any more.
  const rows = await media.findManyByIds(ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const takenByAnotherPost = ids.some((id) => {
    const row = byId.get(id);
    return row !== undefined && row.postId !== null && row.postId !== postId;
  });
  throw new ConflictError(takenByAnotherPost ? MEDIA_TAKEN_MESSAGE : MEDIA_VANISHED_MESSAGE);
}

/**
 * Trims, then validates. In that order deliberately: a body of three spaces is
 * empty, and validating before trimming would accept it.
 */
function requireBody(raw: string): string {
  const body = raw.trim();
  if (body.length === 0) throw new ValidationError(EMPTY_MESSAGE);
  if (body.length > MAX_POST_BODY_LENGTH) throw new ValidationError(TOO_LONG_MESSAGE);
  return body;
}

/**
 * The ownership rules for `mediaIds`, shared by create and edit because they
 * differ by EXACTLY one clause (spec §5.2): an id is accepted when it exists,
 * belongs to the actor, and is either unclaimed or already claimed by
 * `ownPostId` — the post being edited, or `null` on create, where nothing is
 * "already this post's" yet. That last clause is the whole difference, and
 * without it every edit would reject its own existing images.
 *
 * An id claimed by a DIFFERENT post is refused whoever owns it, or editing a
 * post could pull media out of another one — including someone else's.
 *
 * Unknown and not-yours share one message on purpose: media ids are handed out
 * only to their uploader, and a distinct "no such photo" would turn this into
 * an existence oracle for ids belonging to other people.
 *
 * Called BEFORE any write in both use cases, so a refused request leaves the
 * post exactly as it was.
 */
async function requireAttachable(
  media: MediaRepositoryPort,
  actorId: string,
  ids: string[],
  ownPostId: string | null
): Promise<void> {
  if (ids.length === 0) return;
  // One row holds one `position`, so the same id twice would claim it once and
  // hand back a post with fewer images than were asked for — a silent
  // disagreement between request and result, which is exactly what the
  // whole-list semantics exist to prevent.
  if (new Set(ids).size !== ids.length) throw new ValidationError(MEDIA_DUPLICATE_MESSAGE);

  const rows = await media.findManyByIds(ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined || row.ownerId !== actorId) {
      throw new ValidationError(MEDIA_NOT_YOURS_MESSAGE);
    }
    if (row.postId !== null && row.postId !== ownPostId) {
      throw new ValidationError(MEDIA_TAKEN_MESSAGE);
    }
  }
}

export class CreatePost {
  /**
   * Task 5 fix round 2: takes the SAME unit of work `EditPost` does, and for
   * the same reason — the post write and the media claim must land or fail
   * together. Named for "edit" only because `EditPost` needed it first; see
   * `PostEditUnitOfWorkPort`'s own docstring, which now documents both
   * callers.
   */
  constructor(private readonly postWrite: PostEditUnitOfWorkPort) {}

  async execute(input: {
    authorId: string;
    body: string;
    /** The images the new post should hold, in order. Absent and empty mean the same thing here — there is nothing to keep. */
    mediaIds?: string[];
    /**
     * `public` | `members`. Omitted means `public` — a brand-new post has no
     * "current" value to leave alone the way an edit does, so there is
     * nothing here for an omitted field to preserve.
     */
    visibility?: string;
  }): Promise<PostView> {
    const body = requireBody(input.body);
    const mediaIds = input.mediaIds ?? [];
    const visibility = input.visibility ?? "public";
    return this.postWrite.run(async ({ posts, media }) => {
      // Validated before the post row exists: a refused `mediaIds` must not
      // leave a stray post behind.
      await requireAttachable(media, input.authorId, mediaIds, null);
      // Same reason, same place: spec §7's rule, checked against what THIS
      // call is producing, before any row exists to leave behind.
      requireImageWhenLocked(visibility, mediaIds.length);

      const row = await posts.create(input.authorId, body, visibility);
      // `locked: false` — NEVER copy this to a read path. Every `toPostView` in
      // this file answers the post's OWN AUTHOR, who is the one person the
      // paywall never applies to: `CreatePost` and `EditPost` have already
      // proven ownership before reaching here. A read path must instead ask
      // `read-posts.ts`'s gate, which needs a viewer id and a membership lookup
      // that this file has neither of.
      if (mediaIds.length === 0) return toPostView(row, [], false);

      // Inside the SAME transaction as `posts.create` above: `claim` losing
      // the sweep race and `requireFullyClaimed` throwing now rolls the post
      // row back WITH it — see that function's own docstring (Task 5 fix
      // round 2) for why this stopped being an accepted trade-off the
      // instant `visibility` became writable.
      await requireFullyClaimed(media, row.id, await media.claim(row.id, mediaIds), mediaIds);
      // Read back rather than echoing the ids: what the client gets is what a
      // reload would show, ordered by the `position` that was actually stored.
      // `locked: false` for the reason given at the call site above — this is
      // the author's own post coming straight back to them.
      return toPostView(row, await media.listForPost(row.id), false);
    });
  }
}

export class EditPost {
  constructor(private readonly postEdit: PostEditUnitOfWorkPort) {}

  /**
   * Task 5 fix round 1: the WHOLE body — lock, ownership check, resulting-state
   * check, body/visibility write and media claim — runs inside ONE
   * transaction via `this.postEdit.run`. See `PostEditUnitOfWorkPort`'s own
   * docstring for the two concrete paths that left `visibility = 'members'`
   * with zero images before this existed, and why a row lock (not a retry) is
   * what closes them.
   */
  async execute(input: {
    editorId: string;
    postId: string;
    body: string;
    /**
     * The COMPLETE desired list, not a delta (spec §5.2) — the images the post
     * should hold when this returns, in order. Images dropped from it are
     * UNCLAIMED, never deleted (§8), and the worker's sweep collects them.
     *
     * OMITTED is not the same as empty: `[]` is a caller asking for no images,
     * while leaving the field out says nothing about images at all — a
     * text-only edit, which must not silently strip a post's photos.
     */
    mediaIds?: string[];
    /**
     * `public` | `members`. OMITTED means "leave the current visibility
     * alone" — the same omitted-vs-empty idiom `mediaIds` documents just
     * above, for the same reason: a text-only edit must not silently un-gate
     * (or gate) the post. Never defaulted to `public`; see `posts.ts:52` for
     * why `.optional()` here is load-bearing at the route.
     */
    visibility?: string;
  }): Promise<PostView> {
    const body = requireBody(input.body);
    return this.postEdit.run(async ({ posts, media }) => {
      // `lockForEdit`, not `ownershipOf`: this is the row lock the fix round
      // is FOR. Ownership BEFORE the write, and a 403 that does not reveal
      // the body: returning 404 for someone else's post would make the id an
      // existence oracle, and 403 on a post you cannot see reveals nothing
      // you could not learn from the feed, where every post is public in
      // this phase.
      const owned = await posts.lockForEdit(input.postId);
      if (owned === null) throw new NotFoundError("post not found");
      if (owned.authorId !== input.editorId) throw new ForbiddenError(NOT_YOURS_MESSAGE);
      if (owned.isDeleted) throw new NotFoundError("post not found");
      // Before the write, so a rejected image list leaves the body untouched too.
      if (input.mediaIds !== undefined) {
        await requireAttachable(media, input.editorId, input.mediaIds, input.postId);
      }

      // Spec §7, checked against the state this EDIT is producing, not what
      // the row holds right now: an omitted `visibility` keeps `owned.visibility`
      // (see that field's own docstring) — read under the LOCK taken above, so
      // a concurrent edit's write cannot land between this read and this
      // transaction's own write. An omitted `mediaIds` keeps however many
      // images the post already carries — read from the repository ONLY when
      // it might matter, so a text-only edit to a public post never pays for
      // a media query it does not need, and, when it IS read, read under the
      // same lock for the same reason.
      const resultingVisibility = input.visibility ?? owned.visibility;
      if (resultingVisibility === MEMBERS_ONLY) {
        const resultingMediaCount =
          input.mediaIds !== undefined
            ? input.mediaIds.length
            : (await media.listForPost(input.postId)).length;
        requireImageWhenLocked(resultingVisibility, resultingMediaCount);
      }

      // `updateBody` sets `edited_at` unconditionally, which is what makes an
      // IMAGE-ONLY change still count as an edit (§5.3): what a reader saw is
      // not what they would see now, and `PostCard`'s `· diedit` marker exists
      // to say so. `input.visibility` — not `resultingVisibility` — is passed
      // straight through: the repository's own omitted-means-unchanged contract
      // (see `PostRepositoryPort.updateBody`) is exactly what "leave it alone"
      // needs, and passing the already-resolved value here would ask it to
      // rewrite a column that was never asked to change.
      const row = await posts.updateBody(input.postId, body, input.visibility);
      if (row === null) throw new NotFoundError("post not found");
      if (input.mediaIds !== undefined) {
        // Inside the SAME transaction as the write above: `claim` throwing
        // `ConflictError` here rolls `updateBody`'s visibility write back
        // with it, which is fix round 1's path 2 — a 409 now means nothing
        // changed, not "half of it did."
        await requireFullyClaimed(
          media,
          input.postId,
          await media.claim(input.postId, input.mediaIds),
          input.mediaIds
        );
      }
      // `locked: false`: the ownership check above has already established
      // that the editor IS the author, and an author is never locked out of
      // their own post. See `CreatePost`'s call site for why a read path
      // must never copy this literal.
      return toPostView(row, await media.listForPost(input.postId), false);
    });
  }
}

export class DeletePost {
  constructor(private readonly posts: PostRepositoryPort) {}

  /**
   * Idempotent: deleting an already-deleted post returns normally. A button that
   * errors when the state already matches what you asked for is worse than one
   * that agrees — the same ruling follow/unfollow made.
   */
  async execute(input: { deleterId: string; postId: string }): Promise<void> {
    const owned = await this.posts.ownershipOf(input.postId);
    if (owned === null) throw new NotFoundError("post not found");
    if (owned.authorId !== input.deleterId) throw new ForbiddenError(NOT_YOURS_MESSAGE);
    await this.posts.softDelete(input.postId);
  }
}
