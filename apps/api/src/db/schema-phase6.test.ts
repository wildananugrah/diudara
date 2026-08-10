import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "./client";

describe("phase 6 indexes", () => {
  it("indexes activity_log the way the FEED actually reads it", async () => {
    // MEASURED, not assumed. EXPLAIN (ANALYZE, BUFFERS) against live Postgres 16.13,
    // 300 000 rows across six communities, 100 000 of them in the one being read,
    // `limit 26`:
    //
    //   with (community_id, created_at)   0.12 ms, 5 buffers, Index Scan Backward,
    //                                     no full sort
    //   without it                       15.9 ms, 1277 buffers, Bitmap Heap Scan on
    //                                     activity_log_community_id_idx + top-N sort
    //
    // Two orders of magnitude, on the most-viewed screen in the product, and the
    // difference grows with the history because only this index lets the scan STOP
    // after one page instead of reading every row the community has ever produced.
    const rows = await sql`
      select indexdef from pg_indexes
      where tablename = 'activity_log'
        and indexname = 'activity_log_community_created_idx'
    `;
    expect(rows.length).toBe(1);
    const def = String(rows[0].indexdef);
    expect(def).toContain("community_id");
    expect(def).toContain("created_at");
    // Order matters: (created_at, community_id) would not let the community
    // predicate be an index condition, and the scan would be back to reading
    // everybody's rows.
    expect(def.indexOf("community_id")).toBeLessThan(def.indexOf("created_at"));
  });

  it("does NOT carry (community_id, event_type, created_at), which no query reads", async () => {
    // This index existed, added by Task 1 for a query that was never written. It was
    // dropped in migration 0015, on two independent grounds:
    //
    //  a. NOTHING READS activity_log BY event_type. The only read in the API is the
    //     feed (`DrizzleAnalyticsRepository.listActivityForCreator`); every other
    //     touch of this table is an insert. So the index was pure write amplification
    //     on the fastest-growing table in the product — paid on every payment,
    //     reminder, grant and revocation, forever, for nothing.
    //
    //  b. IT MADE THE FEED WORSE. The feed filters `event_type in (<8 values>)`, a
    //     ScalarArrayOp on this index's MIDDLE column, and a btree scan with one of
    //     those cannot deliver rows ordered by the trailing `created_at` — so it can
    //     satisfy neither the ORDER BY nor anything `community_id` alone already
    //     does. Measured independently on 300k rows, with ONLY this index present the
    //     feed ran 145 ms / 3676 buffers against 17 ms with no composite index at
    //     all: it lured the planner into a bitmap scan over 50 000 rows.
    //
    // If a metrics query ever needs `community_id = ? and event_type = ? and
    // created_at >= ?` (it measured 11.7 ms / 246 buffers when this index existed),
    // add it back IN THE MIGRATION THAT ADDS THAT QUERY. Not before.
    const rows = await sql`
      select indexname from pg_indexes
      where tablename = 'activity_log'
        and indexname = 'activity_log_community_event_created_idx'
    `;
    expect(rows.length).toBe(0);
  });

  /**
   * A COMMENT ASSERTION, and it earns its place.
   *
   * The claim that the feed reads through `activity_log_community_event_created_idx`
   * was corrected in `schema.ts` and in the spec, and survived for a whole phase in
   * the file a developer actually opens when they touch this query. A misleading
   * invariant comment is precisely how the next person drops the index that IS load
   * bearing, so the correction is pinned here rather than left to review.
   */
  it("does not let the feed's docstring name the wrong index again", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "infrastructure", "repositories", "drizzle-analytics.repository.ts"),
      "utf8"
    );
    const feedDoc = source.slice(
      source.indexOf("One page of the activity feed"),
      source.indexOf("async listActivityForCreator")
    );
    expect(feedDoc.length).toBeGreaterThan(0);
    expect(feedDoc).toContain("activity_log_community_created_idx");
    // The wrong name may appear only while being disclaimed — "NOT the wider …".
    expect(/READS THROUGH `activity_log_community_event_created_idx`/.test(feedDoc)).toBe(false);
  });
});
