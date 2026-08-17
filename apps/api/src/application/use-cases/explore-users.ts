import type { UserRepositoryPort } from "../ports/user-repository.port";
import type { FollowListRow } from "../ports/follow-repository.port";

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
 */
export class ExploreUsers {
  constructor(private readonly users: UserRepositoryPort) {}

  async execute(input: {
    q?: string;
    limit?: number;
  }): Promise<{ results: FollowListRow[]; newest: FollowListRow[]; mostFollowed: FollowListRow[] }> {
    const limit = input.limit ?? DEFAULT_EXPLORE_LIMIT;
    const query = (input.q ?? "").trim();

    const [newest, mostFollowed, results] = await Promise.all([
      this.users.newestPublic(limit),
      this.users.mostFollowedPublic(limit),
      query.length === 0 ? Promise.resolve<FollowListRow[]>([]) : this.users.searchPublic(query, limit),
    ]);

    return { results, newest, mostFollowed };
  }
}
