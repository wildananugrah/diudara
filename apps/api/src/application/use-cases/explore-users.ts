import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { FollowListRow, FollowRepositoryPort } from "../ports/follow-repository.port";
import {
  resolveViewerFollowSet,
  withViewerFollows,
  type FollowListRowForViewer,
} from "./viewer-follow-state";

/**
 * Page size for each of Jelajah's three lists when a request carries no
 * `?limit=` — mirrors `follow-user.ts`'s `DEFAULT_FOLLOW_LIST_LIMIT` in
 * shape (the single, tested source of truth `routes/users.ts` imports
 * rather than re-declaring — see that constant's own docstring for why a
 * second, untested copy is exactly the defect Task 2's review found). 20 is
 * smaller than the follow list's 50: this default renders THREE lists on
 * one screen at once (results, newest, most-followed) rather than one full
 * page, so a smaller per-list page keeps the screen from being dominated by
 * whichever list happens to load first.
 */
export const DEFAULT_EXPLORE_LIMIT = 20;

/**
 * `GET /users/explore` — Jelajah, the discovery screen a new user with an
 * empty follow graph lands on (plan Task 3). Public, unauthenticated, same
 * as `by-handle`/`followers`/`following`: there is nothing here a signed-out
 * visitor should not see, since every row is the same `FollowListRow`
 * projection (`handle`/`displayName`/`bio`) those routes already expose.
 *
 * **An empty or whitespace-only `q` is the screen's DEFAULT state, not an
 * error or a "no results" search.** `results` is `[]` in that case and
 * `searchPublic` is never even called — `newest` and `mostFollowed` are
 * still populated either way, since Jelajah always shows both discovery
 * rails regardless of whether the visitor has typed anything.
 *
 * Does NOT itself enforce the enumeration-safety guarantee
 * (`searchPublic`/`UserRepositoryPort` does, at the query level — see that
 * port method's own docstring) — this class only decides WHEN to call it.
 *
 * **Every row in all three lists carries `viewerFollows`** as of the final
 * review's item 1. It takes a `FollowRepositoryPort` for that and nothing else:
 * the three read methods still live on `userRepository`, unchanged. The follow
 * state for the WHOLE SCREEN — all three lists at once — is resolved in ONE
 * query over the union of their handles, then mapped three times. Resolving per
 * list would be three queries for one page load, and per row would be up to 60.
 */
export class ExploreUsers {
  constructor(
    private readonly users: UserRepositoryPort,
    private readonly follows: FollowRepositoryPort
  ) {}

  async execute(input: {
    q?: string;
    limit?: number;
    /** The CALLER's id if signed in, `null` if anonymous — see `ListFollows.execute`'s own note. */
    viewerId?: string | null;
  }): Promise<{
    results: FollowListRowForViewer[];
    newest: FollowListRowForViewer[];
    mostFollowed: FollowListRowForViewer[];
  }> {
    const limit = input.limit ?? DEFAULT_EXPLORE_LIMIT;
    const query = (input.q ?? "").trim();

    const [newest, mostFollowed, results] = await Promise.all([
      this.users.newestPublic(limit),
      this.users.mostFollowedPublic(limit),
      query.length === 0 ? Promise.resolve<FollowListRow[]>([]) : this.users.searchPublic(query, limit),
    ]);

    // ONE resolution across all three lists. The same account routinely appears
    // in more than one of them (a newly-created popular account is in both
    // rails), and `resolveViewerFollowSet` de-duplicates before querying.
    const followed = await resolveViewerFollowSet(this.follows, input.viewerId ?? null, [
      ...results.map((row) => row.handle),
      ...newest.map((row) => row.handle),
      ...mostFollowed.map((row) => row.handle),
    ]);

    return {
      results: withViewerFollows(results, followed),
      newest: withViewerFollows(newest, followed),
      mostFollowed: withViewerFollows(mostFollowed, followed),
    };
  }
}
