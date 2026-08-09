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
});
