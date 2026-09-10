import { useCallback, useRef } from "react";
import { COMMUNITY_POST_TYPES } from "@diudara/shared";
import PostComposer from "./PostComposer";
import PostFeed, { type PostFeedHandle } from "./PostFeed";
import { createCommunityPost, listCommunityPosts } from "./apiClient";

interface Props {
  slug: string;
  viewerIsMember: boolean | null;
  viewerIsOwner: boolean;
}

/**
 * The **Diskusi** tab of `/komunitas/:slug` — a `PostFeed` of the community's
 * posts with a composer above it for members (spec §"The web app").
 *
 * **It does not fetch the community, and it renders no join/leave control**
 * (ruling R12) — that lives in `CommunityPage`'s banner, where Phase 1 put it.
 * `slug`, `viewerIsMember` and `viewerIsOwner` come straight from
 * `CommunityPage`'s `CommunityDetail` fetch. Above the feed:
 * - `viewerIsMember === true` (member)      → the `PostComposer`
 * - `viewerIsMember === false` (non-member) → a one-line note pointing at the banner's Gabung
 * - `viewerIsMember === null` (signed out)  → the same, pointing at sign-in
 *
 * The post-type `<select>` is `PostComposer`'s own, shown only to an owner: the
 * composer is handed `COMMUNITY_POST_TYPES` (from `@diudara/shared`, ruling R5)
 * when `viewerIsOwner`, an empty list otherwise — a plain member sees no
 * selector and every submit is a `diskusi`.
 *
 * A submitted post is put on top by `PostFeed`'s `prepend` — no refetch, the
 * pattern `BerandaPage` uses. `PostFeed` is reused with one additive prop,
 * `detailHrefFor`, that gives each card its discussion link (ruling R11).
 */
export default function CommunityFeed({ slug, viewerIsMember, viewerIsOwner }: Props) {
  const feed = useRef<PostFeedHandle>(null);

  // Memoised on `slug` so PostFeed refetches when the community changes and NOT
  // on every render — see PostFeed's own note on the effect loop.
  const load = useCallback((before: string | null) => listCommunityPosts(slug, before), [slug]);

  async function handleCreate(body: string, mediaIds: string[], type?: string): Promise<void> {
    // `type` is the string PostComposer's owner-only <select> produces, handed
    // back in the argument slot a visibility normally uses. A plain member's
    // composer sends nothing here and the server defaults it to `diskusi`.
    const created = await createCommunityPost(slug, {
      body,
      ...(type !== undefined ? { type } : {}),
      ...(mediaIds.length > 0 ? { mediaIds } : {}),
    });
    feed.current?.prepend(created);
  }

  return (
    <section className="community-feed">
      {viewerIsMember === true ? (
        <PostComposer
          key="komunitas-baru"
          submitLabel="Kirim"
          onSubmit={handleCreate}
          postTypeChoices={viewerIsOwner ? COMMUNITY_POST_TYPES : []}
        />
      ) : (
        <p className="community-feed-guestnote">
          {viewerIsMember === false ? "Gabung untuk ikut diskusi." : "Masuk untuk gabung."}
        </p>
      )}

      <PostFeed
        ref={feed}
        load={load}
        ownHandle={null}
        emptyMessage="Belum ada diskusi di komunitas ini."
        detailHrefFor={(id) => `/komunitas/${slug}/diskusi/${id}`}
      />
    </section>
  );
}
