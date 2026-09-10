import { Link } from "react-router-dom";
import type { CommunityListRow } from "./apiClient";
import { communityColor, communityInk } from "./communityColor";

/**
 * One community in the browse grid.
 *
 * The tile's colour comes from `communityColor(slug)` — derived, never stored;
 * see that module for why. Its ink comes from `communityInk(slug)`, which is
 * paired to the hue by measurement: white is unreadable on half this palette.
 * Both are `var(--token)` rather than literals, so
 * `no-hardcoded-colours.test.ts` stays green and a card cannot drift
 * off-palette. They are the only inline styles here, and they have to be
 * inline — the value is computed per community, so no static rule could carry
 * it.
 *
 * The initial in the tile is `aria-hidden`: it is the name's first letter, so a
 * screen reader would otherwise announce "K, Kelas Desain".
 *
 * The description is omitted entirely when absent rather than rendered empty —
 * an empty `<p>` still occupies a grid row and leaves a ragged gap between
 * cards that have one and cards that do not.
 */
export default function CommunityCard({ community }: { community: CommunityListRow }) {
  return (
    <article className="card card-clickable community-card">
      <span
        className="community-card-tile"
        style={{ background: communityColor(community.slug), color: communityInk(community.slug) }}
        aria-hidden="true"
      >
        {community.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="community-card-body">
        <h3 className="community-card-name">
          <Link to={`/komunitas/${community.slug}`}>{community.name}</Link>
        </h3>
        <p className="community-card-meta muted">
          <span className="community-card-category">{community.category}</span>
          <span className="community-card-members">{community.memberCount} anggota</span>
        </p>
        {community.description === null ? null : (
          <p className="community-card-description">{community.description}</p>
        )}
      </div>
    </article>
  );
}
