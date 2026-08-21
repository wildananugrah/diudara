import { MAX_POST_BODY_LENGTH } from "@diudara/shared";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { MediaRepositoryPort } from "../ports/media-repository.port";
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
 * Final whole-branch review, Important 4. `requireAttachable` reads the rows
 * and then `claim` writes them; between those two the orphan sweep can delete a
 * row it listed as unclaimed (a composer left open overnight, then used). Before
 * this, `claim` returned nothing and the missing id was a silent no-op — the
 * author's post came back with fewer photos than they sent, and nothing said so.
 *
 * A 409 rather than a 500 because the person can act on it: upload the photo
 * again. The post row DOES already exist by the time this fires on create,
 * which is the honest cost of the post write and the media claim not being one
 * unit of work — a known, separately recorded decision, and a loud wrong-ish
 * status is still strictly better than silent data loss.
 */
function requireFullyClaimed(claimed: number, ids: string[]): void {
  if (claimed !== ids.length) throw new ConflictError(MEDIA_VANISHED_MESSAGE);
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
  constructor(
    private readonly posts: PostRepositoryPort,
    private readonly media: MediaRepositoryPort
  ) {}

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
    // Validated before the post row exists: a refused `mediaIds` must not
    // leave a stray post behind.
    await requireAttachable(this.media, input.authorId, mediaIds, null);
    // Same reason, same place: spec §7's rule, checked against what THIS
    // call is producing, before any row exists to leave behind.
    requireImageWhenLocked(visibility, mediaIds.length);

    const row = await this.posts.create(input.authorId, body, visibility);
    // `locked: false` — NEVER copy this to a read path. Every `toPostView` in
    // this file answers the post's OWN AUTHOR, who is the one person the
    // paywall never applies to: `CreatePost` and `EditPost` have already
    // proven ownership before reaching here. A read path must instead ask
    // `read-posts.ts`'s gate, which needs a viewer id and a membership lookup
    // that this file has neither of.
    if (mediaIds.length === 0) return toPostView(row, [], false);

    requireFullyClaimed(await this.media.claim(row.id, mediaIds), mediaIds);
    // Read back rather than echoing the ids: what the client gets is what a
    // reload would show, ordered by the `position` that was actually stored.
    // `locked: false` for the reason given at the call site above — this is
    // the author's own post coming straight back to them.
    return toPostView(row, await this.media.listForPost(row.id), false);
  }
}

export class EditPost {
  constructor(
    private readonly posts: PostRepositoryPort,
    private readonly media: MediaRepositoryPort
  ) {}

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
    // Ownership BEFORE the write, and a 403 that does not reveal the body:
    // returning 404 for someone else's post would make the id an existence
    // oracle, and 403 on a post you cannot see reveals nothing you could not
    // learn from the feed, where every post is public in this phase.
    const owned = await this.requireOwn(input.postId, input.editorId);
    if (owned.isDeleted) throw new NotFoundError("post not found");
    // Before the write, so a rejected image list leaves the body untouched too.
    if (input.mediaIds !== undefined) {
      await requireAttachable(this.media, input.editorId, input.mediaIds, input.postId);
    }

    // Spec §7, checked against the state this EDIT is producing, not what
    // the row holds right now: an omitted `visibility` keeps `owned.visibility`
    // (see that field's own docstring), and an omitted `mediaIds` keeps
    // however many images the post already carries — read from the
    // repository ONLY when it might matter, so a text-only edit to a public
    // post never pays for a media query it does not need.
    const resultingVisibility = input.visibility ?? owned.visibility;
    if (resultingVisibility === MEMBERS_ONLY) {
      const resultingMediaCount =
        input.mediaIds !== undefined
          ? input.mediaIds.length
          : (await this.media.listForPost(input.postId)).length;
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
    const row = await this.posts.updateBody(input.postId, body, input.visibility);
    if (row === null) throw new NotFoundError("post not found");
    if (input.mediaIds !== undefined) {
      requireFullyClaimed(await this.media.claim(input.postId, input.mediaIds), input.mediaIds);
    }
    // `locked: false`: `requireOwn` above has already established that the
    // editor IS the author, and an author is never locked out of their own
    // post. See `CreatePost`'s call site for why a read path must never copy
    // this literal.
    return toPostView(row, await this.media.listForPost(input.postId), false);
  }

  private async requireOwn(postId: string, actorId: string) {
    const owned = await this.posts.ownershipOf(postId);
    if (owned === null) throw new NotFoundError("post not found");
    if (owned.authorId !== actorId) throw new ForbiddenError(NOT_YOURS_MESSAGE);
    return owned;
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
