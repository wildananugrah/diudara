import { apiFetch } from "./apiClient";
import { useLoad, type Load, type LoadHandle } from "./useLoad";
import type { Community } from "./types";

/**
 * One community, found in the creator's own list.
 *
 * THERE IS NO `GET /communities/:id`. The API exposes `POST|GET /communities` and
 * `PATCH /communities/:id`, and nothing that reads a single one — so every
 * community screen loads the creator-scoped LIST and picks its own out of it.
 *
 * That is not a workaround so much as it is free correctness: the list is scoped by
 * `creatorId` in the repository, so a community belonging to somebody else simply
 * is not in it, and this returns `null` exactly as the API's 404-not-403 rule
 * intends. There is no way for this to accidentally render a stranger's community
 * because there is no unscoped read to call.
 *
 * The cost is one list fetch per screen. A creator has a handful of communities, so
 * this is not worth a cache that could go stale after a rename; if the list ever
 * grows, add `GET /communities/:id` rather than a client-side cache.
 *
 * `null` data means NOT FOUND (or not yours). An error means the request failed.
 */
export function useCommunity(
  communityId: string | undefined
): [Load<Community | null>, LoadHandle<Community | null>] {
  return useLoad<Community | null>(async () => {
    if (communityId === undefined) return null;
    const communities = await apiFetch<Community[]>("/communities");
    return communities.find((c) => c.id === communityId) ?? null;
  }, [communityId]);
}
