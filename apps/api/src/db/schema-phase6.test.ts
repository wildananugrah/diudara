import { describe, expect, it } from "bun:test";
import { sql } from "./client";

describe("phase 6 indexes", () => {
  it("indexes activity_log the way the dashboard queries it", async () => {
    // The dashboard reads activity_log as `community_id + event_type + created_at`.
    // Without this index every feed page is a seq scan plus a sort, on a table
    // that grows with every payment, reminder, grant and revocation.
    const rows = await sql`
      select indexdef from pg_indexes
      where tablename = 'activity_log'
        and indexname = 'activity_log_community_event_created_idx'
    `;
    expect(rows.length).toBe(1);
    const def = String(rows[0].indexdef);
    expect(def).toContain("community_id");
    expect(def).toContain("event_type");
    expect(def).toContain("created_at");
  });

  it("indexes activity_log the way the FEED actually reads it", async () => {
    // MEASURED, not assumed. `activity_log_community_event_created_idx` above is the
    // index the plan prescribed, and on PostgreSQL 16 the planner does not use it for
    // the feed at all: the feed's predicate is `event_type in (<8 values>)`, a
    // ScalarArrayOp on the index's MIDDLE column, and a btree scan cannot then
    // deliver rows ordered by the trailing `created_at`. So it cannot satisfy the
    // ORDER BY, and for filtering alone it is no better than `community_id`.
    //
    // EXPLAIN (ANALYZE, BUFFERS) against live Postgres 16.13, 300 000 rows across six
    // communities, 100 000 of them in the one being read, `limit 26`:
    //
    //   with the composite index      15.9 ms, 1277 buffers, Bitmap Heap Scan on
    //                                 activity_log_community_id_idx + top-N sort
    //   composite index DROPPED       12.5 ms, 1277 buffers — THE SAME PLAN
    //   with (community_id, created_at)
    //                                  0.12 ms, 5 buffers, Index Scan Backward,
    //                                 no full sort
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
});
