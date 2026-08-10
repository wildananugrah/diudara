import { apiFetch, DashboardApiError } from "./apiClient";
import { useLoad, type Load, type LoadHandle } from "./useLoad";
import type { Community } from "./types";

/**
 * One community, fetched directly by id via `GET /communities/:id`.
 *
 * This used to load the creator-scoped LIST (`GET /communities`) and pick its
 * own community out of it, because no endpoint read a single one — so each of
 * the five per-community screens (overview, tiers, channels, members,
 * activity) paid for the whole list just to display one row. `GetCommunity`
 * (apps/api) closed that gap: `findByIdForCreator` is the SAME creator-scoped
 * lookup `PATCH /communities/:id` already used, so a stranger's id 404s here
 * exactly as it did there — never 403, never confirming the resource exists —
 * and this hook turns that 404 into `null`, preserving the old contract.
 *
 * `null` data means NOT FOUND (or not yours). Any other error propagates.
 */
export function useCommunity(
  communityId: string | undefined
): [Load<Community | null>, LoadHandle<Community | null>] {
  return useLoad<Community | null>(async () => {
    if (communityId === undefined) return null;
    try {
      return await apiFetch<Community>(`/communities/${communityId}`);
    } catch (err) {
      if (err instanceof DashboardApiError && err.status === 404) return null;
      throw err;
    }
  }, [communityId]);
}
