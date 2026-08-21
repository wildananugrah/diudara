import type { MediaRepositoryPort } from "./media-repository.port";
import type { PostRepositoryPort } from "./post-repository.port";

/** The repositories one edit's lock-read-check-write sequence must share one transaction with. */
export interface PostEditRepositories {
  posts: PostRepositoryPort;
  media: MediaRepositoryPort;
}

/**
 * Runs `EditPost`'s lock, resulting-state check, body/visibility write and
 * media claim as ONE atomic unit — Task 5 fix round 1.
 *
 * **WHY THIS EXISTS.** Before this, `EditPost.execute` read `PostOwnership`
 * (unlocked), computed the visibility/image count the edit was PRODUCING, and
 * only then wrote — three separate statements outside any transaction. Once
 * `visibility` became writable (Task 5), that shape opened two concrete paths
 * to the exact state the whole task exists to forbid (`visibility = 'members'`
 * with zero images), traced by code review rather than merely feared:
 *
 *  1. **Two concurrent edits on the same post.** Edit A (flip to `members`,
 *     images untouched) reads the post still holding its one image and
 *     passes its check; before A's write lands, Edit B (`mediaIds: []`,
 *     visibility untouched) reads the post still `public` and passes ITS
 *     check; both commit; the post ends up `members` with nothing behind the
 *     lock, and BOTH requests return success.
 *  2. **A single edit, no concurrency at all.** `updateBody(..., "members")`
 *     commits before the later `claim(...)` call. If `claim` then throws
 *     `ConflictError` (the exact race `requireFullyClaimed`'s own docstring
 *     already names — an image swept away between the ownership check and the
 *     claim), the caller gets a loud 409, but the visibility write already
 *     landed. The row is left `members` with fewer images than required, and
 *     nothing recovers it.
 *
 * **THE FIX IS A ROW LOCK, NOT A RETRY.** `PostRepositoryPort.lockForEdit`
 * takes `SELECT ... FOR UPDATE` on the post row, INSIDE this transaction,
 * before anything is read for the resulting-state check. A second edit on the
 * SAME post blocks at that statement until the first commits or rolls back —
 * closing path 1, because the second edit's own read of `owned.visibility`
 * and (when `mediaIds` is omitted) `media.listForPost` now happens strictly
 * AFTER the first edit's effects are visible, never before. Wrapping the
 * write and the claim in the same transaction closes path 2: `claim`
 * throwing rolls the visibility write back with it, so a 409 here means
 * NOTHING changed, matching what a 409 already means everywhere else in this
 * file.
 *
 * Modelled on `UserPurchaseUnitOfWorkPort`/`JoinRequestUnitOfWorkPort`: the
 * work function receives repositories already bound to the transaction, so
 * no port method grows a "pass the handle in" parameter and no repository has
 * to know whether it is inside one. Anything thrown out of `work` rolls the
 * whole unit back and propagates — including `ConflictError` from a lost
 * claim race, which is exactly path 2's fix.
 */
export interface PostEditUnitOfWorkPort {
  run<T>(work: (repositories: PostEditRepositories) => Promise<T>): Promise<T>;
}
