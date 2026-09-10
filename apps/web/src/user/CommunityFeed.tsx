import { useCallback, useEffect, useRef, useState } from "react";
import { COMMUNITY_POST_TYPES } from "@diudara/shared";
import CommunityJoinControl from "./CommunityJoinControl";
import PostComposer from "./PostComposer";
import PostFeed, { type PostFeedHandle } from "./PostFeed";
import { createCommunityPost, listCommunityPosts } from "./apiClient";

interface Props {
  slug: string;
  viewerIsMember: boolean | null;
  viewerIsOwner: boolean;
  /**
   * Told the resulting membership after a join or leave from THIS tab's
   * control, so `CommunityPage`'s banner member-count stays in step. Optional —
   * the feed keeps its own copy either way.
   */
  onMembershipChange?: (member: boolean) => void;
}

/**
 * The **Diskusi** tab of `/komunitas/:slug` — a `PostFeed` of the community's
 * posts with a composer / join control above it (spec §"The web app").
 *
 * **It does not fetch the community.** `slug`, `viewerIsMember` and
 * `viewerIsOwner` come straight from `CommunityPage`'s `CommunityDetail` fetch.
 *
 * `CommunityJoinControl` is always rendered (it returns `null` for the owner):
 * - `viewerIsMember === null` (signed out)  → a `Masuk untuk gabung` link to `/masuk`
 * - `viewerIsMember === false` (non-member)  → a `Gabung` control
 * - `viewerIsMember === true` (member)       → a `Keluar` control, AND the `PostComposer` below it
 *
 * It is the SAME control Phase 1's banner carried — lifted into
 * `CommunityJoinControl` so it is not duplicated. The banner no longer renders
 * one; the membership control lives here now, beside where posting happens.
 *
 * The post-type `<select>` is `PostComposer`'s own, shown only to an owner: the
 * composer is handed `COMMUNITY_POST_TYPES` (from `@diudara/shared`, ruling R5)
 * when `viewerIsOwner`, an empty list otherwise — a plain member sees no
 * selector and every submit is a `diskusi`.
 *
 * A submitted post is put on top by `PostFeed`'s `prepend` — no refetch, the
 * pattern `BerandaPage` uses. `PostFeed` itself is reused unchanged.
 */
export default function CommunityFeed({
  slug,
  viewerIsMember,
  viewerIsOwner,
  onMembershipChange,
}: Props) {
  // Seeded from the prop and re-synced when it changes (a sign-in in another
  // tab makes CommunityPage re-fetch the detail). The join control updates it
  // immediately, before the parent round-trips.
  const [member, setMember] = useState<boolean | null>(viewerIsMember);
  useEffect(() => {
    setMember(viewerIsMember);
  }, [viewerIsMember]);

  const feed = useRef<PostFeedHandle>(null);

  // Memoised on `slug` so PostFeed refetches when the community changes and NOT
  // on every render — see PostFeed's own note on the effect loop.
  const load = useCallback((before: string | null) => listCommunityPosts(slug, before), [slug]);

  function membershipChanged(next: boolean): void {
    setMember(next);
    onMembershipChange?.(next);
  }

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
      <CommunityJoinControl
        slug={slug}
        viewerIsMember={member}
        viewerIsOwner={viewerIsOwner}
        onChanged={membershipChanged}
      />

      {member === true ? (
        <PostComposer
          key="komunitas-baru"
          submitLabel="Kirim"
          onSubmit={handleCreate}
          postTypeChoices={viewerIsOwner ? COMMUNITY_POST_TYPES : []}
        />
      ) : null}

      <PostFeed
        ref={feed}
        load={load}
        ownHandle={null}
        emptyMessage="Belum ada diskusi di komunitas ini."
      />
    </section>
  );
}
