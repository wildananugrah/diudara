import type { FollowListRow, FollowRepositoryPort } from "../ports/follow-repository.port";

/**
 * A public list row PLUS the viewer's own relationship to it — what
 * `GET /users/explore`, `GET /users/:handle/followers` and
 * `GET /users/:handle/following` all return, as of the final review's item 1.
 *
 * Deliberately a SEPARATE type from `FollowListRow` rather than a widening of
 * it. `FollowListRow` is the REPOSITORY's row: exactly the three columns
 * `publicListColumns` selects, and it must stay that narrow so the projection
 * assertions in both repository test files keep meaning what they say. This
 * type is what the application layer composes on top, and `viewerFollows` comes
 * from a second query, never from a column.
 *
 * `viewerFollows` carries the identical contract to
 * `PublicUserProfile.viewerFollows`: `null` when the request carried no usable
 * viewer (anonymous, or a stale/invalid token on a route that merely NOTICES a
 * session), `boolean` when it did. **`false`, not anything self-specific, on the
 * viewer's OWN row** — nobody can follow themselves, so the honest answer to
 * "do you follow this person?" is `false`, and a client must decide "is this me?"
 * by comparing handles. That is a binding ledger ruling; see `FollowButton`'s
 * own docstring for where the comparison happens.
 */
export interface FollowListRowForViewer extends FollowListRow {
  viewerFollows: boolean | null;
}

/**
 * Resolves, in **ONE query for the whole page**, which of `handles` the viewer
 * already follows. `null` in, `null` out — an anonymous request performs no
 * query at all.
 *
 * The alternative the final review explicitly ruled out was N lookups (or N
 * fetches from the client): `/explore` alone renders up to three lists of 20,
 * and `/followers` up to 100 rows.
 *
 * **Keyed on HANDLE, not on user id, and that is a deliberate departure from
 * the letter of the brief** (which said `followeeId IN (...)` over the page's
 * ids). It is the same single query and the same index; the reason for the
 * change is that the page's rows do not CARRY ids and must not start to. Both
 * `publicListColumns` definitions select exactly `handle`/`displayName`/`bio`
 * precisely so the excluded columns are never fetched from the database in the
 * first place rather than stripped afterwards — pulling `id` back into the
 * projection to key a map on it, then deleting it before serialising, is the
 * shape those docstrings exist to prevent, and a `select()` that fetches an id
 * is one refactor away from returning it. `app_user.handle` is UNIQUE
 * (`app_user_handle_unique`), so it is an equally total key.
 */
export async function resolveViewerFollowSet(
  follows: FollowRepositoryPort,
  viewerId: string | null,
  handles: readonly string[]
): Promise<ReadonlySet<string> | null> {
  if (viewerId === null) return null;
  const unique = [...new Set(handles)];
  // No page, no query. `inArray` with an empty list is also invalid SQL in some
  // drivers, so this is a correctness guard as much as a saving.
  if (unique.length === 0) return new Set<string>();
  return new Set(await follows.followedHandlesAmong(viewerId, unique));
}

/**
 * Maps rows against an already-resolved set, so a screen made of SEVERAL lists
 * (Jelajah's three) resolves once and maps three times rather than querying
 * three times. Split from `resolveViewerFollowSet` for exactly that reason.
 */
export function withViewerFollows(
  rows: readonly FollowListRow[],
  followed: ReadonlySet<string> | null
): FollowListRowForViewer[] {
  return rows.map((row) => ({
    ...row,
    viewerFollows: followed === null ? null : followed.has(row.handle),
  }));
}
