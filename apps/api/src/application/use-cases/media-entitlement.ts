import type { ClockPort } from "../ports/clock.port";
import type { MediaRepositoryPort } from "../ports/media-repository.port";
import type { PostRepositoryPort } from "../ports/post-repository.port";
import type { UserSubscriptionRepositoryPort } from "../ports/user-subscription-repository.port";
import { MEMBERS_ONLY } from "./post-views";

/**
 * The answer `GET /users/media/:id` and `/thumb` act on — BOTH halves of it,
 * from one decision.
 *
 * `allowed` decides the bytes. `gated` decides the `Cache-Control` header, and
 * it is returned from here rather than worked out again at the route for the
 * reason spec §8.1 gives: computed separately the two can disagree, and the
 * failure is a shared cache holding gated images and handing them to
 * strangers — which no assertion on the route's status code would ever catch.
 *
 * `gated` describes the MEDIA, not the caller: an author and a paying member
 * are both `{ allowed: true, gated: true }` for a members-only post. They get
 * their bytes and the response still says `private, no-store`, because a
 * browser cache is shared with whoever else uses that device and a year-long
 * `immutable` entry for a gated image is the same hole one step removed.
 */
export interface MediaGateDecision {
  /** May these bytes be written into the response at all? `false` is a 404, never a 403 (spec §6.2). */
  allowed: boolean;
  /** Do these bytes belong to a members-only post? Decides the cache header, whoever is asking. */
  gated: boolean;
}

/**
 * Refused. `gated: true` on purpose even where the media's visibility could
 * not be established: every refusal here pairs with the header that licenses
 * nothing, so a future caller that renders a refusal with a body can never
 * hand a cache permission this decision did not grant.
 */
const REFUSED: MediaGateDecision = { allowed: false, gated: true };

/** Served, and freely cacheable — a public post's image, or one on no post at all. */
const OPEN: MediaGateDecision = { allowed: true, gated: false };

/** Served to somebody entitled to it, and never publicly cacheable. */
const ENTITLED: MediaGateDecision = { allowed: true, gated: true };

/**
 * **BARRIER TWO of two — the media route refuses an id it never sent** (spec
 * §6.2, §6.4).
 *
 * Barrier one is the projection (`read-posts.ts`), which never puts a gated
 * media id in front of a non-member. That is not a paywall on its own: a
 * paying member holds legitimate ids and can forward one, and for an id
 * obtained that way barrier one has already been bypassed. This class is what
 * makes such a link fail. Neither barrier is sufficient alone, and each must
 * be provable with the other disabled.
 *
 * IT RESOLVES THE MEDIA ROW ITSELF rather than being handed one. A barrier
 * that trusts a row its caller looked up is not independent of that caller: a
 * later refactor passing the wrong row — or a stale one — would open the gate
 * silently. Give it an id and it answers for that id, which is the same
 * property the route is named for.
 *
 * **The clock is read ONCE, at the top, and the instant is passed down.**
 * Phase 5b shipped a residual defect from a use case calling `clock.now()`
 * twice around a query: a membership whose period ended between the two reads
 * was answered inconsistently. One request, one instant.
 *
 * The membership lookup is `listActiveOwnersAmong` — the same `status =
 * 'active' AND current_period_end > now` predicate, against the same partial
 * unique index, that barrier one asks for a whole feed page. A lapsed
 * membership (still `active`, period already over, because 5b's sweep has not
 * retired it yet) is excluded by that second half; a status-only check would
 * serve a former member every gated image they have stopped paying for.
 * `is-member-of.ts` is deliberately untouched — see its own docstring.
 */
export class MediaEntitlement {
  constructor(
    private readonly media: MediaRepositoryPort,
    private readonly posts: PostRepositoryPort,
    private readonly subscriptions: UserSubscriptionRepositoryPort,
    private readonly clock: ClockPort
  ) {}

  /**
   * `viewerId` is REQUIRED and nullable rather than optional, for the reason
   * `ListUserPosts.execute` gives about its own: these routes are publicly
   * reachable, so `null` is the common case, and an optional parameter would
   * let a caller omit it and be answered as if somebody were signed in.
   * `null` is the caller saying "signed out", which locks every gated image.
   *
   * **Unclaimed media (`post_id is null`) is ALLOWED and UNGATED, exactly as
   * before this phase.** Bytes uploaded but not yet attached to a post have no
   * post, and therefore no visibility to read; there is nothing to gate on and
   * inventing an answer would break the composer, which previews an image
   * between the upload and the post that claims it. The id is known only to
   * its uploader, who is the only person who could have received it (spec
   * §6.3).
   *
   * **Media on a soft-deleted post stays gated as it was.** The route keeps
   * serving such an image exactly as it does today; this phase does not change
   * deletion semantics, and deleting a members-only post does not un-gate its
   * images.
   */
  async decide(input: { mediaId: string; viewerId: string | null }): Promise<MediaGateDecision> {
    const now = this.clock.now();

    const row = await this.media.findById(input.mediaId);
    // An id with no row is refused for the same reason a gated one is, and
    // with the same answer — the route turns both into the identical 404, so
    // gated and absent are indistinguishable from outside (spec §6.2).
    if (row === null) return REFUSED;
    if (row.postId === null) return OPEN;

    const post = await this.posts.gatingOf(row.postId);
    // Unreachable today — posts are soft-deleted, never removed — and refused
    // rather than opened anyway. The failure direction of a bug in this class
    // must be "locked out", never "let in", which is the same rule
    // `read-posts.ts` builds its locked-author set around.
    if (post === null) return REFUSED;
    if (post.visibility !== MEMBERS_ONLY) return OPEN;

    // The author is never locked out of their own post, and is never asked
    // about either: nobody subscribes to themselves (`user_subscription_no_self`
    // makes such a row impossible), so the query's answer could not be yes.
    // Checked BEFORE the null test below so a signed-out caller never matches
    // it — `viewerId` is null and `authorId` is a uuid, but the ordering is
    // what makes that independent of the types.
    if (input.viewerId !== null && input.viewerId === post.authorId) return ENTITLED;
    if (input.viewerId === null) return REFUSED;

    const paidFor = await this.subscriptions.listActiveOwnersAmong(
      input.viewerId,
      [post.authorId],
      now
    );
    // `includes`, not `length > 0`: the port promises never to answer an id
    // outside `ownerIds`, and a gate that trusted the count would be one
    // repository bug away from unlocking every creator at once.
    return paidFor.includes(post.authorId) ? ENTITLED : REFUSED;
  }
}
